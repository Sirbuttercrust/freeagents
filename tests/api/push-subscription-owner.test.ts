// FIX-SW4b (SW4-02): a push subscription belongs to the account that
// registered it. Real createApp with signed parties, a Memory push repository
// read back after every call, and a recording PushSender, so "refused" cannot
// mean "refused but stored" and "kept" is shown by a notification still
// reaching the buyer's endpoint. The stranger is a REGISTERED account, so a
// refusal here is the owner rule and not a 401 or 403 for an unknown caller.
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryPushSubscriptionRepository,
} from '../../src/adapters/storage/memory.js';
import type { PushSender } from '../../src/adapters/push/push.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const OWNED_BY_ANOTHER =
  'this push address is registered to another account; turn notifications off there, or subscribe again for a new address';
const ENDPOINT = 'https://push.example.test/owner-rule-endpoint';

let server: Server;
let baseUrl: string;
let buyer: SigningIdentity;
let stranger: SigningIdentity;
let agent: SigningIdentity;
let operator: SigningIdentity;
let pushRepo: MemoryPushSubscriptionRepository;
let sentTo: Array<{ endpoint: string; accountDid: string; p256dh: string }>;

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-push-owner',
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

async function signedRequest(method: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
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
    body: bodyText,
  });
}

function postPush(as: SigningIdentity, endpoint: string, p256dh: string, auth: string): Promise<Response> {
  return signedRequest('POST', `/accounts/${as.did}/push-subscriptions`, { endpoint, keys: { p256dh, auth } }, as);
}

function deletePush(as: SigningIdentity, endpoint: string): Promise<Response> {
  return signedRequest('DELETE', `/accounts/${as.did}/push-subscriptions`, { endpoint }, as);
}

// The operator opens a job with the buyer's agent, then writes in its thread:
// the buyer is the other party, so the platform notifies the buyer and, for
// each of the buyer's stored subscriptions, calls the push sender.
async function notifyBuyer(): Promise<void> {
  const created = await signedRequest('POST', '/jobs', { agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
  expect(created.status).toBe(201);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  const message = await signedRequest('POST', `/jobs/${jobId}/messages`, { body: 'Looking at it now' }, operator);
  expect(message.status).toBe(201);
  // The push loop is not awaited by the route (a slow push service must not
  // hold the request), so wait for it to land.
  for (let i = 0; i < 50 && sentTo.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
}

// A fresh app and repository for every test, so no test inherits another's rows.
beforeEach(async () => {
  buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(221));
  stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(222));
  agent = await signingIdentityFromSeed(new Uint8Array(32).fill(223));
  operator = await signingIdentityFromSeed(new Uint8Array(32).fill(224));

  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: buyer.did, githubLogin: 'buyer-push-owner' });
  await accounts.register({ did: stranger.did, githubLogin: 'stranger-push-owner' });
  await accounts.register({ did: operator.did, githubLogin: 'operator-push-owner' });

  const agents = new MemoryAgentRepository();
  await agents.create({
    did: agent.did,
    operatorDid: operator.did,
    delegation: delegationFixture(agent.did, operator.did) as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-push-owner',
    notifyWebhookUrl: null,
    negotiatesOnOwnersBehalf: false,
  });
  await agents.updateGithubBinding(agent.did, { handle: 'scout-push-owner', status: 'verified' });

  pushRepo = new MemoryPushSubscriptionRepository();
  sentTo = [];
  const pushSender: PushSender = {
    publicKey: null,
    async send(subscription) {
      sentTo.push({ endpoint: subscription.endpoint, accountDid: subscription.accountDid, p256dh: subscription.p256dh });
    },
  };
  const { github } = createStagingLifecycleGithubFake();
  const app = createApp(
    accounts,
    agents,
    undefined,
    github,
    new MemoryJobRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    testSessionAdapter(),
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
    pushRepo,
    undefined,
    pushSender,
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('FIX-SW4b: a push subscription belongs to the account that registered it', () => {
  it('a DELETE from another account answers 204 and leaves the buyer subscription in place and receiving', async () => {
    expect((await postPush(buyer, ENDPOINT, 'buyer-p256dh', 'buyer-auth')).status).toBe(201);

    const del = await deletePush(stranger, ENDPOINT);
    expect(del.status).toBe(204);

    const rows = await pushRepo.listByAccountDid(buyer.did);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: ENDPOINT, accountDid: buyer.did, p256dh: 'buyer-p256dh', auth: 'buyer-auth' });

    await notifyBuyer();
    expect(sentTo).toEqual([{ endpoint: ENDPOINT, accountDid: buyer.did, p256dh: 'buyer-p256dh' }]);
  });

  it('a POST from another account for the buyer endpoint answers 409 with the whole sentence and stores nothing', async () => {
    expect((await postPush(buyer, ENDPOINT, 'buyer-p256dh', 'buyer-auth')).status).toBe(201);

    const take = await postPush(stranger, ENDPOINT, 'stranger-p256dh', 'stranger-auth');
    expect(take.status).toBe(409);
    expect(await take.json()).toEqual({ error: OWNED_BY_ANOTHER });

    const rows = await pushRepo.listByAccountDid(buyer.did);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: ENDPOINT, accountDid: buyer.did, p256dh: 'buyer-p256dh', auth: 'buyer-auth' });
    expect(await pushRepo.listByAccountDid(stranger.did)).toHaveLength(0);
  });

  it('the buyer posting its own endpoint again with new keys answers 201 and replaces the keys in one row', async () => {
    expect((await postPush(buyer, ENDPOINT, 'buyer-p256dh', 'buyer-auth')).status).toBe(201);

    const renewed = await postPush(buyer, ENDPOINT, 'buyer-p256dh-2', 'buyer-auth-2');
    expect(renewed.status).toBe(201);

    const rows = await pushRepo.listByAccountDid(buyer.did);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: ENDPOINT, accountDid: buyer.did, p256dh: 'buyer-p256dh-2', auth: 'buyer-auth-2' });
  });

  it('the buyer deleting its own endpoint answers 204 and leaves no rows', async () => {
    expect((await postPush(buyer, ENDPOINT, 'buyer-p256dh', 'buyer-auth')).status).toBe(201);

    const del = await deletePush(buyer, ENDPOINT);
    expect(del.status).toBe(204);
    expect(await pushRepo.listByAccountDid(buyer.did)).toHaveLength(0);
  });

  it('a DELETE naming an endpoint nobody holds answers 204', async () => {
    const del = await deletePush(buyer, 'https://push.example.test/nobody-holds-this');
    expect(del.status).toBe(204);
  });

  it('a storage failure in the owner look-up answers 503 and stores nothing', async () => {
    pushRepo.findByEndpoint = async () => {
      throw new Error('storage down');
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postPush(buyer, ENDPOINT, 'buyer-p256dh', 'buyer-auth');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage unavailable' });
      expect(await pushRepo.listByAccountDid(buyer.did)).toHaveLength(0);
    } finally {
      quiet.mockRestore();
    }
  });
});
