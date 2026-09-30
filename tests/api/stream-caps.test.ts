// SW4-04 (bugs.md): one caller cannot hold unlimited live streams open.
// Every test drives createApp over a real listening server, opens real SSE
// connections with fetch, and closes every stream it opened and the server it
// started in a finally block, so no socket outlives the test.
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { Job } from '../../src/domain/job.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { MemorySettlementGate } from '../../src/adapters/payment/gate.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const THREAD_SENTENCE =
  'Too many live connections are open for this conversation. Close another tab, or wait a moment and try again.';
const NOTIFICATION_SENTENCE =
  'Too many live connections are open for these notifications. Close another tab, or wait a moment and try again.';
const CALLER_SENTENCE =
  'Too many live connections are open for this account, so this conversation did not open a live one. Close a tab on another page, or wait a moment and try again.';
const NOTIFICATION_CALLER_SENTENCE =
  'Too many live connections are open for this account, so the notifications did not open a live one. Close a tab on another page, or wait a moment and try again.';

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-stream-caps',
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

// One parsed SSE frame and a reader that accumulates them.
interface Frame {
  readonly event: string;
  readonly data: unknown;
}

class FrameReader {
  readonly frames: Frame[] = [];
  private buffered = '';
  private readonly decoder = new TextDecoder();
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  // Reads until `count` frames have arrived in total, then returns them all.
  async until(count: number): Promise<readonly Frame[]> {
    while (this.frames.length < count) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error(`stream ended after ${this.frames.length} frames, wanted ${count}`);
      this.buffered += this.decoder.decode(value, { stream: true });
      const parts = this.buffered.split('\n\n');
      this.buffered = parts.pop() ?? '';
      for (const part of parts) {
        const lines = part.split('\n');
        const event = lines.find((l) => l.startsWith('event: '))?.slice('event: '.length);
        const data = lines.find((l) => l.startsWith('data: '))?.slice('data: '.length);
        if (event !== undefined && data !== undefined) this.frames.push({ event, data: JSON.parse(data) });
      }
    }
    return this.frames;
  }
}

interface Opened {
  readonly res: Response;
  readonly abort: () => void;
}

interface World {
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly operator: SigningIdentity;
  readonly stranger: SigningIdentity;
  // Sockets the server has seen close so far.
  closedSockets(): number;
  draft(as?: SigningIdentity): Promise<string>;
  open(path: string, as: SigningIdentity): Promise<Opened>;
  // Sends the request and hands back the abort before the answer arrives.
  start(path: string, as: SigningIdentity): { readonly answer: Promise<Response>; readonly abort: () => void };
  stream(jobId: string, as: SigningIdentity): Promise<Opened>;
  notifications(did: string, as: SigningIdentity): Promise<Opened>;
  post(jobId: string, body: string, as: SigningIdentity): Promise<Response>;
  signed(method: string, path: string, as: SigningIdentity, body?: unknown): Promise<Response>;
}

// Holds findById open for one job id until release() runs; every other read
// goes straight through. Lets a test park a stream route at its party check.
class HoldableJobRepository extends MemoryJobRepository {
  private held: { readonly id: string; readonly gate: Promise<void>; readonly entered: () => void } | null = null;
  hold(id: string): { readonly release: () => void; readonly entered: Promise<void> } {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    this.held = { id, gate, entered };
    return {
      release: () => {
        this.held = null;
        release();
      },
      entered: enteredPromise,
    };
  }
  override async findById(id: string): Promise<Job | null> {
    const held = this.held;
    if (held !== null && held.id === id) {
      held.entered();
      await held.gate;
    }
    return super.findById(id);
  }
}

async function withWorld(run: (world: World) => Promise<void>, jobRepo: MemoryJobRepository = new MemoryJobRepository()): Promise<void> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(171));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(172));
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(173));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(174));

  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: buyer.did, githubLogin: 'buyer-stream-caps' });
  await accounts.register({ did: operator.did, githubLogin: 'operator-stream-caps' });
  await accounts.register({ did: stranger.did, githubLogin: 'stranger-stream-caps' });
  const agents = new MemoryAgentRepository();
  await agents.create({
    did: agent.did,
    operatorDid: operator.did,
    delegation: delegationFixture(agent.did, operator.did) as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-stream-caps',
  });
  await agents.updateGithubBinding(agent.did, { handle: 'scout-stream-caps', status: 'verified' });

  const { github } = createStagingLifecycleGithubFake();
  const server: Server = createApp(
    accounts,
    agents,
    undefined,
    github,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    testSessionAdapter(),
    undefined,
    new MemorySettlementGate(),
  ).listen(0, '127.0.0.1');
  let closedSockets = 0;
  server.on('connection', (socket: Socket) => {
    socket.on('close', () => {
      closedSockets += 1;
    });
  });
  const controllers: AbortController[] = [];
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const signedHeaders = (method: string, targetUri: string, as: SigningIdentity, bodyText: string) => {
      const s = signRequest(as, method, targetUri, bodyText === '' ? {} : { body: bodyText });
      return { 'signature-input': s['signature-input'], signature: s.signature, 'content-digest': s['content-digest'] };
    };
    const signed = (method: string, path: string, as: SigningIdentity, body?: unknown): Promise<Response> => {
      const bodyText = body === undefined ? '' : JSON.stringify(body);
      const targetUri = `${baseUrl}${path}`;
      return fetch(targetUri, {
        method,
        headers: { 'content-type': 'application/json', ...signedHeaders(method, targetUri, as, bodyText) },
        ...(body === undefined ? {} : { body: bodyText }),
      });
    };
    const start = (path: string, as: SigningIdentity) => {
      const controller = new AbortController();
      controllers.push(controller);
      const targetUri = `${baseUrl}${path}`;
      const answer = fetch(targetUri, { headers: signedHeaders('GET', targetUri, as, ''), signal: controller.signal });
      return { answer, abort: () => controller.abort() };
    };
    const open = async (path: string, as: SigningIdentity): Promise<Opened> => {
      const started = start(path, as);
      return { res: await started.answer, abort: started.abort };
    };
    await run({
      baseUrl,
      buyer,
      operator,
      stranger,
      closedSockets: () => closedSockets,
      draft: async (as = buyer) => {
        const res = await signed('POST', '/jobs', as, {
          agentDid: agent.did,
          repository: 'buyer/target-repo',
          brief: 'Fix the login bug',
        });
        expect(res.status).toBe(201);
        return String(((await res.json()) as Record<string, unknown>).id);
      },
      open,
      start,
      stream: (jobId, as) => open(`/jobs/${jobId}/messages/stream`, as),
      notifications: (did, as) => open(`/accounts/${encodeURIComponent(did)}/notifications/stream`, as),
      post: (jobId, body, as) => signed('POST', `/jobs/${jobId}/messages`, as, { body }),
      signed,
    });
  } finally {
    for (const c of controllers) c.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Polls a condition the server settles by itself; never a fixed sleep.
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function expectStream(opened: Opened): void {
  expect(opened.res.status).toBe(200);
  expect(opened.res.headers.get('content-type')).toBe('text/event-stream');
}

async function expectRefused(opened: Opened, sentence: string): Promise<void> {
  expect(opened.res.status).toBe(429);
  expect(opened.res.headers.get('retry-after')).toBe('30');
  expect(await opened.res.json()).toEqual({ error: sentence });
}

describe('SW4-04: stream caps per caller', () => {
  it('(a) one party holds 3 thread streams on one job, the 4th is refused with 429, and the other party is unaffected', async () => {
    await withWorld(async (w) => {
      const jobId = await w.draft();
      for (let i = 0; i < 3; i++) expectStream(await w.stream(jobId, w.buyer));
      await expectRefused(await w.stream(jobId, w.buyer), THREAD_SENTENCE);
      // The cap is per caller: the job's other party still opens one.
      expectStream(await w.stream(jobId, w.operator));
    });
  });

  it('(b) a place is released when a stream is aborted, so the same caller can open again', async () => {
    await withWorld(async (w) => {
      const jobId = await w.draft();
      const held = [await w.stream(jobId, w.buyer), await w.stream(jobId, w.buyer), await w.stream(jobId, w.buyer)];
      for (const h of held) expectStream(h);
      await expectRefused(await w.stream(jobId, w.buyer), THREAD_SENTENCE);
      const before = w.closedSockets();
      const [first] = held;
      first?.abort();
      await until(() => w.closedSockets() > before, 'the server to see the abort');
      expectStream(await w.stream(jobId, w.buyer));
    });
  });

  it('(c) one caller is held to 10 live streams across conversations and notifications', async () => {
    await withWorld(async (w) => {
      const jobs = [await w.draft(), await w.draft(), await w.draft()];
      for (const jobId of jobs) for (let i = 0; i < 3; i++) expectStream(await w.stream(jobId, w.buyer));
      // Nine threads so far; the tenth place goes to the notifications.
      expectStream(await w.notifications(w.buyer.did, w.buyer));
      // No target is at 3 here (notifications holds 1), so only the total can refuse this.
      await expectRefused(await w.notifications(w.buyer.did, w.buyer), NOTIFICATION_CALLER_SENTENCE);
      // A fourth conversation is refused on the same total.
      await expectRefused(await w.stream(await w.draft(), w.buyer), CALLER_SENTENCE);
      // Another caller is not counted against this one.
      expectStream(await w.notifications(w.operator.did, w.operator));
    });
  });

  it('(d) the notification stream: 3 for the account owner, the 4th is refused with 429', async () => {
    await withWorld(async (w) => {
      for (let i = 0; i < 3; i++) expectStream(await w.notifications(w.buyer.did, w.buyer));
      await expectRefused(await w.notifications(w.buyer.did, w.buyer), NOTIFICATION_SENTENCE);
    });
  });

  it('(e) a refused stream never subscribes: a message reaches exactly the open streams', async () => {
    await withWorld(async (w) => {
      const jobId = await w.draft();
      const open = [await w.stream(jobId, w.buyer), await w.stream(jobId, w.buyer), await w.stream(jobId, w.buyer)];
      const readers = open.map((o) => {
        expectStream(o);
        return new FrameReader(o.res.body!.getReader());
      });
      await expectRefused(await w.stream(jobId, w.buyer), THREAD_SENTENCE);
      const posted = await w.post(jobId, 'after the refusal', w.buyer);
      expect(posted.status).toBe(201);
      // The typing signal is a sentinel: once it arrives, every earlier frame has.
      expect((await w.signed('POST', `/jobs/${jobId}/typing`, w.buyer)).status).toBe(204);
      for (const reader of readers) {
        const frames = await reader.until(2);
        expect(frames.map((f) => f.event)).toEqual(['message', 'typing']);
        expect(frames.map((f) => f.data)).toEqual([expect.objectContaining({ body: 'after the refusal' }), { party: 'buyer' }]);
      }
    });
  });

  it('(f) a stranger gets the existing 403, not a 429, even with its own cap full', async () => {
    await withWorld(async (w) => {
      const target = await w.draft();
      // The stranger is a party to four jobs of its own and fills its 10 places there.
      const ownJobs: string[] = [];
      for (let j = 0; j < 4; j++) ownJobs.push(await w.draft(w.stranger));
      for (const jobId of ownJobs.slice(0, 3)) for (let i = 0; i < 3; i++) expectStream(await w.stream(jobId, w.stranger));
      const last = ownJobs.slice(3).join('');
      expectStream(await w.stream(last, w.stranger));
      await expectRefused(await w.stream(last, w.stranger), CALLER_SENTENCE);

      const refused = await w.stream(target, w.stranger);
      expect(refused.res.status).toBe(403);
      expect(refused.res.headers.get('retry-after')).toBeNull();
      expect(await refused.res.json()).toEqual({ error: 'signature does not name a party to this job' });

      const notAnOwner = await w.notifications(w.buyer.did, w.stranger);
      expect(notAnOwner.res.status).toBe(403);
      expect(notAnOwner.res.headers.get('retry-after')).toBeNull();
      expect(await notAnOwner.res.json()).toEqual({ error: 'an account may only stream its own notifications' });
    });
  });

  it('(g) a client that aborts while the route checks its party leaves no place behind', async () => {
    const jobRepo = new HoldableJobRepository();
    await withWorld(async (w) => {
      const jobId = await w.draft();
      const hold = jobRepo.hold(jobId);
      const parked = w.start(`/jobs/${jobId}/messages/stream`, w.buyer);
      parked.answer.catch(() => undefined);
      await hold.entered;
      // The route is waiting on its job read. The client leaves, then the route goes on.
      const before = w.closedSockets();
      parked.abort();
      await until(() => w.closedSockets() > before, 'the server to see the abort');
      hold.release();
      const streams = [await w.stream(jobId, w.buyer), await w.stream(jobId, w.buyer), await w.stream(jobId, w.buyer)];
      for (const s of streams) expectStream(s);
    }, jobRepo);
  });
});
