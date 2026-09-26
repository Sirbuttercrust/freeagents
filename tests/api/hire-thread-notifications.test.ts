// HT1 Part B (STEER item 4 + bugs.md B19): notifications, webhook
// delivery, and the deposit/remainder-paid system events. Injects the
// message/notification repositories and a fake WebhookSender directly so
// assertions read storage state rather than re-deriving it from HTTP
// responses alone.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
  MemoryMessageRepository,
  MemoryThreadReadStateRepository,
  MemoryNotificationRepository,
  MemoryAttachmentRepository,
  MemoryPushSubscriptionRepository,
  MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { createUsdcPaymentRail, type UsdcObservedTransfer } from '../../src/adapters/payment/usdc.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import type { WebhookSender } from '../../src/adapters/webhook/webhook.js';
import type { PushSender } from '../../src/adapters/push/push.js';
import type { Notification } from '../../src/domain/notification.js';

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-notifications',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${agentDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000001';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000001';
const USDC_CHAIN_ID = 421614;

function withUsdcEnv<T>(fn: () => T): T {
  const vars: Record<string, string> = {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID),
    FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

let server: Server;
let baseUrl: string;
let buyer: SigningIdentity;
let agent: SigningIdentity;
let operator: SigningIdentity;
let messageRepo: MemoryMessageRepository;
let notificationRepo: MemoryNotificationRepository;
let settlementRepo: MemorySettlementRepository;
let sentWebhooks: Array<{ url: string; notification: Notification }>;

async function req(method: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, method, targetUri, { body: bodyText });
  return fetch(targetUri, {
    method,
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    ...(body === undefined ? {} : { body: bodyText }),
  });
}

async function walkToConfirmed(): Promise<string> {
  const created = await req('POST', '/jobs', {
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await req('POST', `/jobs/${jobId}/criteria`, {
    criteria: [{ text: 'The bug is fixed', proposedBy: 'agent' }],
    priceUsd: '500.00',
    rail: 'usdc',
  }, operator);
  await req('POST', `/jobs/${jobId}/criteria/0/accept`, undefined, buyer);
  await req('POST', `/jobs/${jobId}/criteria/0/accept`, undefined, operator);
  await req('POST', `/jobs/${jobId}/price/accept`, undefined, buyer);
  await req('POST', `/jobs/${jobId}/price/accept`, undefined, operator);
  return jobId;
}

async function walkToStaged(): Promise<string> {
  const jobId = await walkToConfirmed();
  await req('POST', `/jobs/${jobId}/payments/deposit/usdc/start`, undefined, buyer);
  await req(
    'POST',
    `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
    { priceTxHash: '0xdep-price', feeTx: { signed: true, hash: '0xdep-fee' } },
    buyer,
  );
  await req('POST', `/jobs/${jobId}/confirm`, undefined, buyer);
  await req('POST', `/jobs/${jobId}/stage`, { stagedCommit: 'commit-notify-1' }, agent);
  return jobId;
}

describe('HT1 Part B: notifications, webhook delivery, settlement system events', () => {
  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(171));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(172));
    operator = await signingIdentityFromSeed(new Uint8Array(32).fill(173));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-notify' });
    await operatorRepo.register({ did: operator.did, githubLogin: 'operator-notify' });
    await operatorRepo.setOperatorAddressEvm(operator.did, USDC_OPERATOR_ADDRESS);

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: operator.did,
      delegation: delegationFixture(agent.did, operator.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-notify',
      notifyWebhookUrl: 'https://operator.example/webhook',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-notify', status: 'verified' });

    const jobRepo = new MemoryJobRepository();
    messageRepo = new MemoryMessageRepository();
    const threadReadStateRepo = new MemoryThreadReadStateRepository();
    notificationRepo = new MemoryNotificationRepository();
    const attachmentRepo = new MemoryAttachmentRepository();
    const pushSubscriptionRepo = new MemoryPushSubscriptionRepository();
    settlementRepo = new MemorySettlementRepository();
    const gate = new PrismaSettlementGate(settlementRepo);
    const sessionAdapter = testSessionAdapter();
    const { github } = createStagingLifecycleGithubFake();

    sentWebhooks = [];
    const fakeWebhookSender: WebhookSender = {
      async send(url, notification) {
        sentWebhooks.push({ url, notification });
      },
    };
    const fakePushSender: PushSender = { publicKey: null, async send() {} };

    const usdcRail = withUsdcEnv(() =>
      createUsdcPaymentRail({
        chainClient: {
          decimals: async () => 6,
          getTransactionReceipt: async (hash: string) => {
            const map: Record<string, { status: number; transfer: UsdcObservedTransfer }> = {
              '0xdep-price': { status: 1, transfer: { to: USDC_OPERATOR_ADDRESS, value: '125000000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } },
              '0xdep-fee': { status: 1, transfer: { to: USDC_FEE_ADDRESS, value: '7500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } },
              '0xrem-price': { status: 1, transfer: { to: USDC_OPERATOR_ADDRESS, value: '375000000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } },
              '0xrem-fee': { status: 1, transfer: { to: USDC_FEE_ADDRESS, value: '22500000', tokenContract: USDC_TOKEN, chainId: USDC_CHAIN_ID } },
            };
            return map[hash.toLowerCase()] ?? null;
          },
        },
        rateSource: async () => '1',
        halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
        spentTransferStorage: { record: async () => {}, findByHash: async () => null },
      }),
    );

    server = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      github,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      gate,
      anyCommitStagingObserver(),
      undefined,
      null,
      usdcRail,
      settlementRepo,
      undefined,
      undefined,
      messageRepo,
      threadReadStateRepo,
      notificationRepo,
      attachmentRepo,
      pushSubscriptionRepo,
      fakeWebhookSender,
      fakePushSender,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('a new brief notifies the agent operator, not the buyer who opened it', async () => {
    const jobId = await walkToConfirmed();
    const rows = await notificationRepo.listByAccountDid(operator.did);
    const newBrief = rows.find((r) => r.jobId === jobId && r.eventType === 'new_brief');
    expect(newBrief).toBeDefined();
    const buyerRows = await notificationRepo.listByAccountDid(buyer.did);
    expect(buyerRows.some((r) => r.jobId === jobId && r.eventType === 'new_brief')).toBe(false);
  });

  it('a quote change fires the agent webhook, signed and carrying no message body', async () => {
    sentWebhooks.length = 0;
    const jobId = await walkToConfirmed();
    expect(sentWebhooks.length).toBeGreaterThan(0);
    const call = sentWebhooks.find((w) => w.notification.jobId === jobId && w.notification.eventType === 'quote_changed');
    expect(call).toBeDefined();
    expect(call?.url).toBe('https://operator.example/webhook');
    expect(call?.notification.eventType).toBe('quote_changed');
    expect(Object.keys(call?.notification ?? {})).not.toContain('body');
  });

  it('a deposit settling on USDC writes a deposit_paid system row and notifies both parties', async () => {
    const jobId = await walkToConfirmed();
    await req('POST', `/jobs/${jobId}/payments/deposit/usdc/start`, undefined, buyer);
    const res = await req(
      'POST',
      `/jobs/${jobId}/payments/deposit/usdc/wallet-response`,
      { priceTxHash: '0xdep-price', feeTx: { signed: true, hash: '0xdep-fee' } },
      buyer,
    );
    expect(res.status).toBe(200);
    const confirmed = (await res.json()) as { confirmed: boolean };
    expect(confirmed.confirmed).toBe(true);

    const settled = await settlementRepo.findByJobAndLeg(jobId, 'deposit');
    expect(settled).not.toBeNull();

    const messages = await messageRepo.listByJobId(jobId);
    const depositRow = messages.find((m) => m.systemEvent?.type === 'deposit_paid');
    expect(depositRow).toBeDefined();
    expect(depositRow?.systemEvent).toMatchObject({ type: 'deposit_paid', leg: 'deposit', amountUsd: '125.00', rail: 'usdc' });
    // Never a wallet address or a transaction hash (STEER's own words).
    expect(JSON.stringify(depositRow?.systemEvent)).not.toContain(USDC_OPERATOR_ADDRESS);
    expect(JSON.stringify(depositRow?.systemEvent)).not.toContain('0xdep-price');

    const buyerNotifications = await notificationRepo.listByAccountDid(buyer.did);
    expect(buyerNotifications.some((n) => n.jobId === jobId && n.eventType === 'new_message')).toBe(true);

    // Proof r1, defect 8 (the read-through-the-route half): the row must
    // be visible reading GET /jobs/:jobId/messages as BOTH parties, not
    // only through messageRepo directly.
    const asBuyer = await req('GET', `/jobs/${jobId}/messages`, undefined, buyer);
    const asBuyerBody = (await asBuyer.json()) as { messages: Array<Record<string, unknown>> };
    expect(asBuyerBody.messages.some((m) => (m.systemEvent as Record<string, unknown> | null)?.type === 'deposit_paid')).toBe(true);
    const asOperator = await req('GET', `/jobs/${jobId}/messages`, undefined, operator);
    const asOperatorBody = (await asOperator.json()) as { messages: Array<Record<string, unknown>> };
    expect(asOperatorBody.messages.some((m) => (m.systemEvent as Record<string, unknown> | null)?.type === 'deposit_paid')).toBe(true);
  });

  // Proof r1, defect 8: the B19 STEER asks for one route-level test PER
  // LEG, reading the thread as buyer and owner. Only the deposit leg
  // existed; this covers the remainder leg through the full route walk
  // (confirm, stage, then the remainder wallet-response).
  it('a remainder settling on USDC writes a remainder_paid system row, read through the route as both parties', async () => {
    const jobId = await walkToStaged();
    await req('POST', `/jobs/${jobId}/payments/remainder/usdc/start`, undefined, buyer);
    const res = await req(
      'POST',
      `/jobs/${jobId}/payments/remainder/usdc/wallet-response`,
      { priceTxHash: '0xrem-price', feeTx: { signed: true, hash: '0xrem-fee' } },
      buyer,
    );
    expect(res.status).toBe(200);
    const confirmed = (await res.json()) as { confirmed: boolean };
    expect(confirmed.confirmed).toBe(true);

    const settled = await settlementRepo.findByJobAndLeg(jobId, 'remainder');
    expect(settled).not.toBeNull();

    const asBuyer = await req('GET', `/jobs/${jobId}/messages`, undefined, buyer);
    const asBuyerBody = (await asBuyer.json()) as { messages: Array<Record<string, unknown>> };
    const buyerRow = asBuyerBody.messages.find((m) => (m.systemEvent as Record<string, unknown> | null)?.type === 'remainder_paid');
    expect(buyerRow).toBeDefined();
    expect(buyerRow?.systemEvent).toMatchObject({ type: 'remainder_paid', leg: 'remainder', amountUsd: '375.00', rail: 'usdc' });
    expect(JSON.stringify(buyerRow?.systemEvent)).not.toContain(USDC_OPERATOR_ADDRESS);
    expect(JSON.stringify(buyerRow?.systemEvent)).not.toContain('0xrem-price');

    const asOperator = await req('GET', `/jobs/${jobId}/messages`, undefined, operator);
    const asOperatorBody = (await asOperator.json()) as { messages: Array<Record<string, unknown>> };
    expect(asOperatorBody.messages.some((m) => (m.systemEvent as Record<string, unknown> | null)?.type === 'remainder_paid')).toBe(true);
  });
});

// Proof r1, defect 7: the webhook gate ("never contacted unless both
// enabled negotiation AND set the webhook") only ever had a positive
// test. This block covers both negative halves against the real route,
// each with its own agent fixture and its own webhook spy.
describe('HT1 Part B (STEER item 4): the webhook gate stays closed unless BOTH conditions hold', () => {
  async function startWithAgent(agentOverrides: { notifyWebhookUrl: string | null; negotiatesOnOwnersBehalf: boolean }): Promise<{
    readonly server: Server;
    readonly baseUrl: string;
    readonly buyer: SigningIdentity;
    readonly agent: SigningIdentity;
    readonly operator: SigningIdentity;
    readonly sentWebhooks: Array<{ url: string; notification: Notification }>;
  }> {
    const localBuyer = await signingIdentityFromSeed(new Uint8Array(32).fill(191));
    const localAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(192));
    const localOperator = await signingIdentityFromSeed(new Uint8Array(32).fill(193));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: localBuyer.did, githubLogin: 'buyer-webhook-gate' });
    await operatorRepo.register({ did: localOperator.did, githubLogin: 'operator-webhook-gate' });

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: localAgent.did,
      operatorDid: localOperator.did,
      delegation: delegationFixture(localAgent.did, localOperator.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-webhook-gate',
      notifyWebhookUrl: agentOverrides.notifyWebhookUrl,
      negotiatesOnOwnersBehalf: agentOverrides.negotiatesOnOwnersBehalf,
    });
    await agentRepo.updateGithubBinding(localAgent.did, { handle: 'scout-webhook-gate', status: 'verified' });

    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
    const { github } = createStagingLifecycleGithubFake();
    const localSentWebhooks: Array<{ url: string; notification: Notification }> = [];
    const fakeWebhookSender: WebhookSender = {
      async send(url, notification) {
        localSentWebhooks.push({ url, notification });
      },
    };
    const fakePushSender: PushSender = { publicKey: null, async send() {} };

    const app = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      github,
      jobRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fakeWebhookSender,
      fakePushSender,
    );
    const started = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => started.once('listening', resolve));
    const address = started.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    return {
      server: started,
      baseUrl: `http://127.0.0.1:${address.port}`,
      buyer: localBuyer,
      agent: localAgent,
      operator: localOperator,
      sentWebhooks: localSentWebhooks,
    };
  }

  async function postDraft(base: string, buyerId: SigningIdentity, agentId: SigningIdentity): Promise<string> {
    const bodyText = JSON.stringify({ agentDid: agentId.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' });
    const targetUri = `${base}/jobs`;
    const signed = signRequest(buyerId, 'POST', targetUri, { body: bodyText });
    const res = await fetch(targetUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'signature-input': signed['signature-input'],
        signature: signed.signature,
        'content-digest': signed['content-digest'],
      },
      body: bodyText,
    });
    const body = (await res.json()) as Record<string, unknown>;
    return String(body.id);
  }

  it('negotiatesOnOwnersBehalf on, but no webhook URL set: zero sends', async () => {
    const started = await startWithAgent({ notifyWebhookUrl: null, negotiatesOnOwnersBehalf: true });
    try {
      await postDraft(started.baseUrl, started.buyer, started.agent);
      expect(started.sentWebhooks.length).toBe(0);
    } finally {
      started.server.close();
    }
  });

  it('a webhook URL set, but negotiatesOnOwnersBehalf off: zero sends', async () => {
    const started = await startWithAgent({ notifyWebhookUrl: 'https://operator.example/webhook', negotiatesOnOwnersBehalf: false });
    try {
      await postDraft(started.baseUrl, started.buyer, started.agent);
      expect(started.sentWebhooks.length).toBe(0);
    } finally {
      started.server.close();
    }
  });

  it('both conditions on: the webhook fires (the positive control, proving the harness itself is not silently broken)', async () => {
    const started = await startWithAgent({ notifyWebhookUrl: 'https://operator.example/webhook', negotiatesOnOwnersBehalf: true });
    try {
      await postDraft(started.baseUrl, started.buyer, started.agent);
      expect(started.sentWebhooks.length).toBeGreaterThan(0);
    } finally {
      started.server.close();
    }
  });
});
