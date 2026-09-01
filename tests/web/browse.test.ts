// R-20 (ENT-2.2, D1): what the browse page actually RENDERS, with the real
// script running against the real API. Mirrors tests/web/agent-cold-start.
// test.ts and tests/web/render.test.ts for style: jsdom loads the served
// page, lets its own script run, and the assertions read the DOM a visitor
// is left looking at rather than the JSON the API returned.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const OPERATOR_DID = 'did:abt:zBrowsePageOperator';
const COLD_DID = 'did:abt:zBrowsePageColdAgent';
const HIRED_DID = 'did:abt:zBrowsePageHiredAgent';

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:browse-page-${agentDid}`,
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

function credentialDoc(id: string, subjectDid: string, mergeCommit: string, buyerDid: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-08-30T00:00:00.000Z',
        mergeCommit,
        signedBy: `${subjectDid}#key-1`,
        buyer: buyerDid,
        additions: 4,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const jobRepo = new MemoryJobRepository();

  await agentRepo.create({
    did: COLD_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(COLD_DID),
    name: 'Cold Start Agent',
    skills: ['typescript'],
    githubLogin: null,
  });

  await agentRepo.create({
    did: HIRED_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(HIRED_DID),
    name: 'Hired Agent',
    skills: ['python', 'triage'],
    githubLogin: null,
  });
  await credentialRepo.save({
    completedJobId: 'browse-page-job-1',
    subjectDid: HIRED_DID,
    document: credentialDoc('https://platform.example/v1/credentials/browse-page-job-1', HIRED_DID, 'browse-page-commit-1', 'did:example:buyer-a'),
    repositoryPublic: true,
  });
  // The buyer count (PR 89) comes from completed jobs, not from the
  // credential store: a real completed job is what buyerDiversity()
  // actually resolves.
  await jobRepo.create({
    id: 'browse-page-job-1',
    buyerDid: 'did:example:buyer-a',
    agentDid: HIRED_DID,
    repository: 'buyer/target-repo',
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
    createdAt: new Date('2026-08-29T00:00:00Z'),
  });
  await jobRepo.complete(
    {
      id: 'browse-page-job-1',
      buyerDid: 'did:example:buyer-a',
      agentDid: HIRED_DID,
      repository: 'buyer/target-repo',
      brief: 'Fix the checkout flow',
      briefHash: 'sha256:brief',
      confirmedSpecHash: null,
      status: 'completed',
      criteria: [],
      pullRequestUrl: null,
      mergeCommit: 'browse-page-commit-1',
      mergedAt: new Date('2026-08-30T00:00:00Z'),
      confirmedAt: null,
      submittedAt: null,
      deadline: null,
      createdAt: new Date('2026-08-29T00:00:00Z'),
    },
    {
      jobId: 'browse-page-job-1',
      buyerDid: 'did:example:buyer-a',
      agentDid: HIRED_DID,
      mergeCommit: 'browse-page-commit-1',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );

  const app = createApp(new MemoryAccountRepository(), agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Rendered {
  document: Document;
  close: () => void;
}

async function render(path: string): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
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

  return { document: dom.window.document, close: () => dom.window.close() };
}

describe('the browse page (R-20)', () => {
  it('renders one card per agent, each carrying the evidence row on the card itself', async () => {
    const page = await render('/browse');
    try {
      const cards = page.document.querySelectorAll('[data-agent-card]');
      expect(cards.length).toBe(2);

      const hiredCard = Array.from(cards).find((c) => c.getAttribute('data-agent-card') === HIRED_DID);
      expect(hiredCard).toBeTruthy();
      const text = hiredCard?.textContent ?? '';
      // Three separately labelled counts, on the card, not behind a click.
      expect(text).toContain('1 verified hire');
      expect(text).toContain('verified prior work');
      expect(text).toContain('portfolio');
      // Buyer diversity rides the verified count: "N verified hires, M buyers" shape.
      expect(text).toMatch(/1 verified hire.*1 buyer/s);
    } finally {
      page.close();
    }
  });

  it('a cold-start agent renders honest zeros on its card, not an absence', async () => {
    const page = await render('/browse');
    try {
      const cards = page.document.querySelectorAll('[data-agent-card]');
      const coldCard = Array.from(cards).find((c) => c.getAttribute('data-agent-card') === COLD_DID);
      expect(coldCard).toBeTruthy();
      const text = coldCard?.textContent ?? '';
      expect(text).toContain('0 verified hires');
    } finally {
      page.close();
    }
  });

  it('the filter bar labels skills as self-asserted', async () => {
    const page = await render('/browse');
    try {
      const label = page.document.body.textContent ?? '';
      expect(label.toLowerCase()).toContain('self-asserted');
    } finally {
      page.close();
    }
  });

  it('the sort control offers exactly the three named keys, and no popularity or upvote sort', async () => {
    const page = await render('/browse');
    try {
      const select = page.document.getElementById('sort') as HTMLSelectElement | null;
      expect(select).toBeTruthy();
      const values = Array.from(select?.options ?? []).map((o) => o.value);
      expect(values.sort()).toEqual(['recently-listed', 'recently-verified', 'verified-hires'].sort());
      const wholeText = (page.document.body.textContent ?? '').toLowerCase();
      expect(wholeText).not.toContain('popular');
      expect(wholeText).not.toContain('upvote');
      expect(wholeText).not.toContain('trending');
    } finally {
      page.close();
    }
  });

  it('filtering by skill via the query string narrows the list', async () => {
    const page = await render('/browse?skill=python');
    try {
      const cards = page.document.querySelectorAll('[data-agent-card]');
      expect(cards.length).toBe(1);
      expect(cards[0]?.getAttribute('data-agent-card')).toBe(HIRED_DID);
    } finally {
      page.close();
    }
  });

  it('each card links to the agent profile', async () => {
    const page = await render('/browse');
    try {
      const link = page.document.querySelector(`a[href="/agents/${encodeURIComponent(HIRED_DID)}"]`);
      expect(link).toBeTruthy();
    } finally {
      page.close();
    }
  });
});
