// SW1-04: GET /capabilities stopped at job.hire, so an agent reading only that
// document had no declared step after opening a hire. The document now names
// the 19 hire-loop routes. This file holds the new entries to the router: a
// declared path is a registered route (ROUTE_TABLE is held to the router by
// tests/architecture/rate-limit-enforcement.test.ts), the served body names
// each route, and an unsigned caller is answered the way each entry says.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { ROUTE_TABLE } from '../../src/api/rate-limit-classes.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { CAPABILITIES, requiresIdentity } from '../../src/domain/access.js';
import { createJob } from '../../src/domain/job.js';

const JOB_ID = 'capabilities-hire-loop-job';

// The 21 routes of a hire after it opens (19 POST, 2 GET), as `method path`,
// in the order the document lists them.
const HIRE_LOOP_ROUTES: readonly string[] = [
  'GET /jobs/:jobId',
  'GET /jobs/:jobId/payments',
  'POST /jobs/:jobId/criteria',
  'POST /jobs/:jobId/request-changes',
  'POST /jobs/:jobId/criteria/:index/accept',
  'POST /jobs/:jobId/price/accept',
  'POST /jobs/:jobId/confirm',
  'POST /jobs/:jobId/withdraw',
  'POST /jobs/:jobId/decline',
  'POST /jobs/:jobId/payments/:leg/abt/start',
  'POST /jobs/:jobId/payments/:leg/usdc/start',
  'POST /jobs/:jobId/payments/:leg/usdc/wallet-response',
  'POST /jobs/:jobId/payments/:leg/abt_eth/start',
  'POST /jobs/:jobId/payments/:leg/abt_eth/wallet-response',
  'POST /jobs/:jobId/stage',
  'POST /jobs/:jobId/staged-decline',
  'POST /jobs/:jobId/redo',
  'POST /jobs/:jobId/redo-refuse',
  'POST /jobs/:jobId/pull-request',
  'POST /jobs/:jobId/merge',
  'POST /jobs/:jobId/cited-close',
];

// app.ts sessionOrSignatureRequiredMessage(...) for resolveJobActingParty.
const UNSIGNED_ANSWER =
  "this route requires a session (sign in with GitHub OAuth or a passkey) or a verified request signature (R-34); sign in, or sign the request naming this job's buyer or agent DID";

// Every route but criteria answers 401 to an empty body. criteria checks its
// body's shape first (400 to {}), so it is sent one it accepts.
function bodyFor(path: string): Record<string, unknown> {
  if (path === '/jobs/:jobId/criteria') return { criteria: [{ text: 'The login bug is fixed', proposedBy: 'buyer' }] };
  return {};
}

// The concrete URL of a declared pattern for the planted job.
function concrete(path: string): string {
  return path.replace(':jobId', JOB_ID).replace(':index', '0').replace(':leg', 'deposit');
}

let server: Server;
let baseUrl: string;
let jobs: MemoryJobRepository;

beforeAll(async () => {
  jobs = new MemoryJobRepository();
  const job = createJob(
    {
      id: JOB_ID,
      buyerDid: 'did:abt:capabilities-hire-loop-buyer',
      agentDid: 'did:abt:capabilities-hire-loop-agent',
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug',
    },
    new Date(),
  );
  await jobs.create(job);
  server = createApp(new MemoryAccountRepository(), new MemoryAgentRepository(), undefined, undefined, jobs).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

describe('SW1-04: GET /capabilities names every step of a hire after it opens', () => {
  it('every declared capability has a ROUTE_TABLE row with the same method and pattern', () => {
    const rows = new Set(ROUTE_TABLE.map((row) => `${row.method} ${row.pattern}`));
    const unregistered = CAPABILITIES.map((cap) => `${cap.method} ${cap.path}`).filter((route) => !rows.has(route));
    expect(unregistered, 'a capability whose method and path no route is registered under').toEqual([]);
  });

  it('the served document names the 19 POST routes and the 2 GET routes, read from the body', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: Array<{ method: string; path: string }> };
    const named = body.capabilities.map((c) => `${c.method} ${c.path}`);
    expect(HIRE_LOOP_ROUTES.filter((route) => route.startsWith('POST '))).toHaveLength(19);
    expect(HIRE_LOOP_ROUTES.filter((route) => route.startsWith('GET '))).toHaveLength(2);
    expect(named.filter((route) => HIRE_LOOP_ROUTES.includes(route))).toEqual(HIRE_LOOP_ROUTES);
  });

  it('the served job.withdraw reason is the whole sentence, and it names staged-decline for staged work', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    const body = (await res.json()) as { capabilities: Array<{ id: string; reason: string }> };
    // The reason does not list every refusal. The transition table in
    // src/domain/job.ts has no withdrawn edge from staged or redo_requested
    // (the buyer's exit there is staged-decline), and the route also refuses a
    // proposed hire whose deposit has settled. tests/api/job-withdraw.test.ts
    // pins the 409 from staged and redo_requested and the 200 from submitted.
    expect(body.capabilities.find((c) => c.id === 'job.withdraw')?.reason).toBe(
      'Only the buyer may withdraw, if the hire allows it (staged work uses staged-decline); the party comes from your session or signature, never the body.',
    );
  });

  it('every identified per-job capability answers an unsigned request 401 with the route\'s own sentence, and the job is unchanged', async () => {
    const perJob = CAPABILITIES.filter((cap) => cap.access === 'identified' && cap.path.startsWith('/jobs/:jobId'));
    expect(perJob.map((cap) => `${cap.method} ${cap.path}`)).toEqual(HIRE_LOOP_ROUTES.slice(1));
    const before = structuredClone(await jobs.findById(JOB_ID));
    expect(before?.status).toBe('draft');

    for (const cap of perJob) {
      // A GET carries no body; a POST is sent the one its route reads first.
      const res = await fetch(`${baseUrl}${concrete(cap.path)}`, {
        method: cap.method,
        headers: { 'content-type': 'application/json' },
        ...(cap.method === 'GET' ? {} : { body: JSON.stringify(bodyFor(cap.path)) }),
      });
      expect(res.status, `${cap.method} ${cap.path}`).toBe(401);
      expect(await res.json(), `${cap.method} ${cap.path}`).toEqual({ error: UNSIGNED_ANSWER });
    }

    expect(await jobs.findById(JOB_ID)).toEqual(before);
  });

  it('GET /jobs/:jobId answers a caller with no identity 200', async () => {
    const res = await fetch(`${baseUrl}/jobs/${JOB_ID}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(JOB_ID);
  });

  it('requiresIdentity is true for POST confirm and false for GET a job', () => {
    expect(requiresIdentity('POST', '/jobs/:jobId/confirm')).toBe(true);
    expect(requiresIdentity('GET', '/jobs/:jobId')).toBe(false);
  });
});
