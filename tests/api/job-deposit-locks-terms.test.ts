// FIX-B74 (bugs.md B74): once the buyer's deposit has settled, a proposed job
// takes no criteria/price proposal and no withdraw. Decline already refused
// (DEP1); this pins the other two doors, plus the depositSettled key on
// GET /jobs/:jobId that lets a page word the paid state.
//
// The fixture pays a deposit the way the payment doors leave it: the gate
// says settled AND the settlement repository holds the row, because the
// routes read the gate and GET /jobs/:jobId reads the repository.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemorySettlementGate } from '../../src/adapters/payment/gate.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryMessageRepository,
  MemoryNotificationRepository,
  MemorySettlementRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const TERMS_SENTENCE = (jobId: string): string =>
  `job ${jobId} has a settled deposit; its terms can no longer change. The buyer confirms the hire to start the work.`;
const WITHDRAW_SENTENCE = (jobId: string): string =>
  `job ${jobId} has a settled deposit; it can no longer be withdrawn. Confirm the hire to start the work.`;

const CRITERIA = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

// A gate whose deposit question can be made to fail, for the 503 pins.
class FailableGate extends MemorySettlementGate {
  failing = false;
  override async depositSettled(jobId: string): Promise<boolean> {
    if (this.failing) throw new Error('settlement store down');
    return super.depositSettled(jobId);
  }
}

interface Harness {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly gate: FailableGate;
  readonly settlementRepo: MemorySettlementRepository;
  readonly messageRepo: MemoryMessageRepository;
  readonly notificationRepo: MemoryNotificationRepository;
}

let active: Harness | null = null;
afterEach(() => {
  active?.server.close();
  active = null;
});

async function start(): Promise<Harness> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(141));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(142));
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-deposit-locks' });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-deposit-locks',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-deposit-locks',
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-deposit-locks', status: 'verified' });
  const gate = new FailableGate();
  const settlementRepo = new MemorySettlementRepository();
  const messageRepo = new MemoryMessageRepository();
  const notificationRepo = new MemoryNotificationRepository();
  const { github } = createStagingLifecycleGithubFake();
  const server = createApp(
    operatorRepo, agentRepo, undefined, github, new MemoryJobRepository(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    gate, anyCommitStagingObserver(), undefined, null, null, settlementRepo, undefined, undefined,
    messageRepo, undefined, notificationRepo,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return {
    server, baseUrl: `http://127.0.0.1:${address.port}`, buyer, agent, gate, settlementRepo, messageRepo, notificationRepo,
  };
}

async function send(h: Harness, method: 'GET' | 'POST', path: string, identity?: SigningIdentity, body?: unknown): Promise<Response> {
  const targetUri = `${h.baseUrl}${path}`;
  if (identity === undefined) return fetch(targetUri, { method });
  const bodyText = body === undefined ? '' : JSON.stringify(body);
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

// A proposed job with every line and the price carrying both marks and the
// window pinned: the moment the deposit leg becomes payable.
async function signedProposedJob(h: Harness): Promise<string> {
  const created = await send(h, 'POST', '/jobs', h.buyer, {
    buyerDid: h.buyer.did,
    agentDid: h.agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  });
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  const proposed = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, {
    criteria: CRITERIA, priceUsd: '500.00', rail: 'abt', deliveryWindowDays: 14,
  });
  expect(proposed.status).toBe(200);
  for (const index of [0, 1]) {
    await send(h, 'POST', `/jobs/${jobId}/criteria/${index}/accept`, h.buyer, {});
    await send(h, 'POST', `/jobs/${jobId}/criteria/${index}/accept`, h.agent, {});
  }
  await send(h, 'POST', `/jobs/${jobId}/price/accept`, h.buyer, {});
  await send(h, 'POST', `/jobs/${jobId}/price/accept`, h.agent, {});
  return jobId;
}

async function payDeposit(h: Harness, jobId: string): Promise<void> {
  h.gate.markDepositSettled(jobId);
  await h.settlementRepo.record({
    jobId,
    leg: 'deposit',
    rail: 'abt',
    hash: `hash-deposit-${jobId}`,
    secondaryHash: null,
    operatorAddress: 'z1Operator',
    feeAddress: 'z1Fee',
    amountUsd: '125.00',
    observedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

async function readJob(h: Harness, jobId: string): Promise<Record<string, unknown>> {
  return (await (await send(h, 'GET', `/jobs/${jobId}`)).json()) as Record<string, unknown>;
}

// Everything a change could touch, without the payableRails / depositSettled
// keys this card is about: the job as the parties agreed it.
function terms(job: Record<string, unknown>): unknown {
  const { payableRails: _rails, depositSettled: _paid, ...rest } = job;
  return rest;
}

async function counts(h: Harness, jobId: string): Promise<{ thread: number; agentNotes: number; buyerNotes: number }> {
  return {
    thread: (await h.messageRepo.listByJobId(jobId)).length,
    agentNotes: (await h.notificationRepo.listByAccountDid('did:abt:op-deposit-locks')).length,
    buyerNotes: (await h.notificationRepo.listByAccountDid(h.buyer.did)).length,
  };
}

describe('(a) a paid proposed job takes no change to its terms', () => {
  it('refuses the agent\'s criteria re-propose, the agent\'s price change and the buyer\'s added line with the terms sentence, and the job reads back unchanged', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    await payDeposit(h, jobId);
    const before = await readJob(h, jobId);
    expect(before.status).toBe('proposed');

    const reproposed = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, {
      criteria: [CRITERIA[0], { text: 'A sharper second line', proposedBy: 'agent' }],
    });
    expect(reproposed.status).toBe(409);
    expect(((await reproposed.json()) as { error: string }).error).toBe(TERMS_SENTENCE(jobId));

    const repriced = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, {
      criteria: CRITERIA, priceUsd: '600.00', rail: 'abt', deliveryWindowDays: 30,
    });
    expect(repriced.status).toBe(409);
    expect(((await repriced.json()) as { error: string }).error).toBe(TERMS_SENTENCE(jobId));

    const added = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.buyer, {
      criteria: [...CRITERIA, { text: 'One more thing', proposedBy: 'buyer' }],
    });
    expect(added.status).toBe(409);
    expect(((await added.json()) as { error: string }).error).toBe(TERMS_SENTENCE(jobId));

    const after = await readJob(h, jobId);
    expect(terms(after)).toEqual(terms(before));
    const price = after.price as Record<string, unknown>;
    expect(price.priceUsd).toBe('500.00');
    expect(price.deliveryWindowDays).toBe(14);
    expect(price.acceptedByBuyer).toBe(true);
    expect(price.acceptedByAgent).toBe(true);
    const criteria = after.criteria as Array<{ acceptedByBuyer: boolean; acceptedByAgent: boolean }>;
    expect(criteria).toHaveLength(2);
    expect(criteria.every((c) => c.acceptedByBuyer && c.acceptedByAgent)).toBe(true);
  });

  it('a confirmed job\'s criteria call still answers the transition table\'s own 409 sentence, not the deposit one', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    await payDeposit(h, jobId);
    expect((await send(h, 'POST', `/jobs/${jobId}/confirm`, h.buyer, {})).status).toBe(200);
    const late = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, { criteria: CRITERIA });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe(
      `cannot propose criteria for a job in status "confirmed"`,
    );
  });
});

describe('(b) a paid proposed job cannot be withdrawn', () => {
  it('answers 409 with the withdraw sentence and the job stays proposed', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    await payDeposit(h, jobId);
    const withdrawn = await send(h, 'POST', `/jobs/${jobId}/withdraw`, h.buyer, {});
    expect(withdrawn.status).toBe(409);
    expect(((await withdrawn.json()) as { error: string }).error).toBe(WITHDRAW_SENTENCE(jobId));
    expect((await readJob(h, jobId)).status).toBe('proposed');
  });

  it('a confirmed paid job can still be withdrawn: the gate is read at proposed only', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    await payDeposit(h, jobId);
    expect((await send(h, 'POST', `/jobs/${jobId}/confirm`, h.buyer, {})).status).toBe(200);
    const withdrawn = await send(h, 'POST', `/jobs/${jobId}/withdraw`, h.buyer, {});
    expect(withdrawn.status).toBe(200);
    expect(((await withdrawn.json()) as { status: string }).status).toBe('withdrawn');
  });
});

describe('(c) before the deposit is marked, both routes behave as before', () => {
  it('criteria re-propose answers 200 and the buyer\'s withdraw answers 200', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    const repriced = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, {
      criteria: CRITERIA, priceUsd: '600.00', rail: 'abt', deliveryWindowDays: 14,
    });
    expect(repriced.status).toBe(200);
    const withdrawn = await send(h, 'POST', `/jobs/${jobId}/withdraw`, h.buyer, {});
    expect(withdrawn.status).toBe(200);
    expect(((await withdrawn.json()) as { status: string }).status).toBe('withdrawn');
  });
});

describe('(d) a settlement gate that throws answers 503 and changes nothing', () => {
  it('both routes answer storage unavailable and the job reads back unchanged', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    const before = await readJob(h, jobId);
    const beforeCounts = await counts(h, jobId);
    h.gate.failing = true;

    const criteria = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, {
      criteria: CRITERIA, priceUsd: '600.00', rail: 'abt',
    });
    expect(criteria.status).toBe(503);
    expect(await criteria.json()).toEqual({ error: 'storage unavailable' });
    const withdraw = await send(h, 'POST', `/jobs/${jobId}/withdraw`, h.buyer, {});
    expect(withdraw.status).toBe(503);
    expect(await withdraw.json()).toEqual({ error: 'storage unavailable' });

    h.gate.failing = false;
    expect(terms(await readJob(h, jobId))).toEqual(terms(before));
    expect(await counts(h, jobId)).toEqual(beforeCounts);
  });
});

describe('(e) a refused criteria call writes no quote row and no notification', () => {
  it('the thread and both accounts\' notifications are the same size before and after a refused price change', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    // The walk itself wrote quote rows and notifications: the pin is that the
    // refused call adds none, and that a NON-refused price change does add
    // them (so the counts can move at all in this harness).
    await payDeposit(h, jobId);
    const before = await counts(h, jobId);
    expect(before.thread).toBeGreaterThan(0);
    const refused = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, {
      criteria: CRITERIA, priceUsd: '600.00', rail: 'abt',
    });
    expect(refused.status).toBe(409);
    expect(await counts(h, jobId)).toEqual(before);
    const rows = await h.messageRepo.listByJobId(jobId);
    expect(rows.filter((m) => JSON.stringify(m.systemEvent).includes('600.00'))).toEqual([]);
  });

  it('control: the same price change before payment does write the quote row and the notification', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    const before = await counts(h, jobId);
    const changed = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, {
      criteria: CRITERIA, priceUsd: '600.00', rail: 'abt',
    });
    expect(changed.status).toBe(200);
    const after = await counts(h, jobId);
    expect(after.thread).toBe(before.thread + 1);
    expect(after.buyerNotes).toBe(before.buyerNotes + 1);
  });
});

describe('(f) GET /jobs/:jobId carries depositSettled on a proposed job only', () => {
  it('true on a paid proposed job, false on an unpaid one, absent on a confirmed one and on POST /jobs', async () => {
    active = await start();
    const h = active;
    const created = await send(h, 'POST', '/jobs', h.buyer, {
      buyerDid: h.buyer.did, agentDid: h.agent.did, repository: 'buyer/target-repo', brief: 'A fresh draft',
    });
    expect(Object.keys((await created.json()) as object)).not.toContain('depositSettled');

    const jobId = await signedProposedJob(h);
    expect((await readJob(h, jobId)).depositSettled).toBe(false);
    await payDeposit(h, jobId);
    expect((await readJob(h, jobId)).depositSettled).toBe(true);

    expect((await send(h, 'POST', `/jobs/${jobId}/confirm`, h.buyer, {})).status).toBe(200);
    const confirmed = await readJob(h, jobId);
    expect(confirmed.status).toBe('confirmed');
    expect(Object.keys(confirmed)).not.toContain('depositSettled');
  });
});

describe('(g) invariant 2: a refused change leaves no trace in the digest', () => {
  it('specHash after confirm recomputes from the job\'s own fields with node:crypto alone', async () => {
    active = await start();
    const h = active;
    const jobId = await signedProposedJob(h);
    await payDeposit(h, jobId);
    const refused = await send(h, 'POST', `/jobs/${jobId}/criteria`, h.agent, {
      criteria: [{ text: 'Sneak in a different line', proposedBy: 'agent' }], priceUsd: '900.00', rail: 'abt',
    });
    expect(refused.status).toBe(409);

    const confirmed = await send(h, 'POST', `/jobs/${jobId}/confirm`, h.buyer, {});
    expect(confirmed.status).toBe(200);
    const body = (await confirmed.json()) as Record<string, unknown>;
    const price = body.price as { priceUsd: string; rail: string; depositPercent: number; redoAllowance: number; deliveryWindowDays: number | null };
    const criteria = body.criteria as Array<{ text: string }>;
    expect(criteria.map((c) => c.text)).toEqual(CRITERIA.map((c) => c.text));
    expect(price.priceUsd).toBe('500.00');
    const joined = [
      ...criteria.map((c) => c.text),
      `price:${price.priceUsd}`,
      `rail:${price.rail}`,
      `deposit:${price.depositPercent}`,
      `redo:${price.redoAllowance}`,
      `window:${price.deliveryWindowDays}`,
    ].join('\n');
    expect('sha256:' + createHash('sha256').update(joined).digest('hex')).toBe(body.specHash);
  });
});
