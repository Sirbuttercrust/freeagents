// R-37 (spec/roadmap.md, ENT-2, ENT-4): the profile page renders
// lastHireCompletedAt and recordLastChangedAt as plain facts, item 3/4 of
// the card. No "stale" badge, no warning colour, no "inactive" label, and
// no accusatory framing on the null case (item 5): a date is a date, and
// the reader judges. Same rendering harness as tests/web/agent-cold-start.test.ts.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { Job } from '../../src/domain/job.js';

const OPERATOR_DID = 'did:abt:zR37Operator';
const COLD_DID = 'did:abt:zR37ColdAgent';
const HIRED_DID = 'did:abt:zR37HiredAgent';

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:r37-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zProof',
    },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string; agentDid: string }): Job {
  return {
    buyerDid: 'did:example:r37-buyer',
    repository: 'buyer/r37-repo',
    brief: 'Fix the checkout flow',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'draft',
    criteria: [],
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();

  await agentRepo.create({
    did: COLD_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(COLD_DID),
    name: 'cold-start-agent',
    skills: ['triage'],
    githubLogin: null,
  });

  await agentRepo.create({
    did: HIRED_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(HIRED_DID),
    name: 'hired-agent',
    skills: ['react'],
    githubLogin: null,
  });
  const draft = jobFixture({ id: 'r37-job-1', agentDid: HIRED_DID });
  await jobRepo.create(draft);
  await jobRepo.complete(
    { ...draft, status: 'completed', mergeCommit: 'r37cafe', mergedAt: new Date('2026-08-30T00:00:00Z') },
    {
      jobId: draft.id,
      buyerDid: draft.buyerDid,
      agentDid: HIRED_DID,
      mergeCommit: 'r37cafe',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );

  const app = createApp(undefined, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function render(path: string): Promise<Document> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  expect(response.status, `unexpected status for ${path}`).toBe(200);
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => fetch(new URL(input, baseUrl), init),
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);

  return dom.window.document;
}

const ACCUSATORY_PHRASES = ['never hired', 'no activity', 'inactive', 'stale', 'abandoned'];

describe('agent profile renders freshness as plain facts (R-37)', () => {
  it('a cold-start agent (no completed hire) renders a last-hire fact honestly, with no accusatory framing', async () => {
    const document = await render(`/agents/${COLD_DID}`);
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const phrase of ACCUSATORY_PHRASES) {
      expect(text, `page text should not contain "${phrase}"`).not.toContain(phrase);
    }
  });

  it('does not carry a "stale" badge, warning colour class, or freshness-based label anywhere on the page', async () => {
    const document = await render(`/agents/${HIRED_DID}`);
    expect(document.querySelectorAll('[class*="stale" i], [data-stale], [class*="fresh" i]').length).toBe(0);
  });

  it('carries the record-last-changed fact as a readable date on the technical details panel', async () => {
    const document = await render(`/agents/${HIRED_DID}`);
    const recordChanged = document.getElementById('tech-record-changed')?.textContent ?? '';
    expect(recordChanged.length).toBeGreaterThan(0);
    expect(recordChanged).not.toBe('not recorded');
  });

  it('carries the last-hire-completed fact, and a cold-start agent renders it honestly as not recorded', async () => {
    const hiredDocument = await render(`/agents/${HIRED_DID}`);
    const hiredLastHire = hiredDocument.getElementById('tech-last-hire')?.textContent ?? '';
    expect(hiredLastHire.length).toBeGreaterThan(0);
    expect(hiredLastHire).not.toBe('not recorded');

    const coldDocument = await render(`/agents/${COLD_DID}`);
    const coldLastHire = coldDocument.getElementById('tech-last-hire')?.textContent ?? '';
    expect(coldLastHire).toBe('not recorded');
  });
});
