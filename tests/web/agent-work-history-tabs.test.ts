// W1 (spec/wireframe/agent.html): the work history section is ONE list with
// a tab bar (All / Hires / Prior / Claims) carrying live counts, and the
// record sentence names verified prior work and unchecked claims beside the
// hire count. Same rendering harness as tests/web/agent-cold-start.test.ts:
// jsdom loads the served page, lets its own script run, and the assertions
// read the DOM a visitor is left looking at.
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
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import type { Job } from '../../src/domain/job.js';

const OPERATOR_DID = 'did:abt:zTabsOperator';
const AGENT_DID = 'did:abt:zTabsAgent';

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:tabs-${agentDid}`,
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

function credentialDoc(id: string, subjectDid: string, repository: string, mergeCommit: string, repositoryPublic: boolean): { document: VerifiableCredential; repositoryPublic: boolean; completedJobId: string; subjectDid: string } {
  return {
    completedJobId: mergeCommit,
    subjectDid,
    repositoryPublic,
    document: {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id,
      type: ['VerifiableCredential', 'CompletedHireCredential'],
      issuer: 'did:abt:platform',
      validFrom: '2026-08-30T00:00:00.000Z',
      credentialSubject: {
        id: subjectDid,
        hire: {
          brief: 'sha256:brief',
          repository,
          pullRequest: `https://github.com/${repository}/pull/1`,
          mergedAt: '2026-08-30T00:00:00.000Z',
          mergeCommit,
          signedBy: `${subjectDid}#key-1`,
          buyer: 'did:example:tabs-buyer',
          additions: 10,
          deletions: 2,
          filesChanged: 1,
        },
      },
      proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
    },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string; agentDid: string }): Job {
  return {
    buyerDid: 'did:example:tabs-buyer',
    repository: 'buyer/tabs-repo',
    brief: 'Fix the checkout flow',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'draft',
    criteria: [],
    priceUsd: null,
    rail: null,
    priceAcceptedByBuyer: false,
    priceAcceptedByAgent: false,
    depositPercent: 25,
    redoAllowance: 1,
    redoUsedCount: 0,
    redoRequestedCriterionIndex: null,
    redoRequestedAt: null,
    redoRefusedAt: null,
    stagedLapseExtensionDays: 0,
    deliveryWindowDays: null,
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    stagedAt: null,
    stagedCommit: null,
    stagingRepo: null,
    baseCommit: null,
    stagingRepoDeleteAfter: null,
    citedCloseCriterionIndex: null,
    citedCloseReasonText: null,
    citedCloseAuthorDid: null,
    citedCloseAt: null,
    deemedCompletedAt: null,
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
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_DID),
    name: 'tabs-agent',
    skills: ['react'],
    githubLogin: null,
  });

  // One verified hire (public repo, merged) and one portfolio claim
  // (private repo, merged, demoted by invariant 4): exercises two of the
  // three tiers so the chip counts and the section-visibility toggle both
  // have real, DIFFERENT numbers to prove against.
  const hireDraft = jobFixture({ id: 'tabs-job-hire', agentDid: AGENT_DID });
  await jobRepo.create(hireDraft);
  await jobRepo.complete(
    { ...hireDraft, status: 'completed', mergeCommit: 'tabshire', mergedAt: new Date('2026-08-30T00:00:00Z') },
    { jobId: hireDraft.id, buyerDid: hireDraft.buyerDid, agentDid: AGENT_DID, mergeCommit: 'tabshire', completedAt: new Date('2026-08-30T00:00:00Z') },
  );
  await credentialRepo.save(
    credentialDoc('https://platform.example/v1/credentials/tabs-job-hire', AGENT_DID, 'buyer/tabs-repo-a', 'tabshire', true),
  );

  const claimDraft = jobFixture({ id: 'tabs-job-claim', agentDid: AGENT_DID });
  await jobRepo.create(claimDraft);
  await jobRepo.complete(
    { ...claimDraft, status: 'completed', mergeCommit: 'tabsclaim', mergedAt: new Date('2026-08-30T00:00:00Z') },
    { jobId: claimDraft.id, buyerDid: claimDraft.buyerDid, agentDid: AGENT_DID, mergeCommit: 'tabsclaim', completedAt: new Date('2026-08-30T00:00:00Z') },
  );
  await credentialRepo.save(
    credentialDoc('https://platform.example/v1/credentials/tabs-job-claim', AGENT_DID, 'buyer/tabs-repo-b', 'tabsclaim', false),
  );

  const app = createApp(undefined, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function render(): Promise<Document> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}/agents/${AGENT_DID}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  expect(response.status).toBe(200);
  const markup = await response.text();

  const dom = new JSDOM(markup, {
    url: `${baseUrl}/agents/${AGENT_DID}`,
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

describe('the work history tab bar filters the three tier sections (wireframe agent.html)', () => {
  it('the "Hires" chip shows the hire section and hides prior work and portfolio', async () => {
    const document = await render();
    const hiresChip = document.querySelector('[data-bucket="hire"]') as HTMLButtonElement | null;
    expect(hiresChip).not.toBeNull();

    hiresChip!.click();

    expect(document.getElementById('history-section')?.hidden).toBe(false);
    expect(document.getElementById('prior-work-section')?.hidden).toBe(true);
    expect(document.getElementById('portfolio-section')?.hidden).toBe(true);
  });

  it('the "All" chip shows all three sections again', async () => {
    const document = await render();
    const hiresChip = document.querySelector('[data-bucket="hire"]') as HTMLButtonElement | null;
    const allChip = document.querySelector('[data-bucket="all"]') as HTMLButtonElement | null;
    hiresChip!.click();
    allChip!.click();

    expect(document.getElementById('history-section')?.hidden).toBe(false);
    expect(document.getElementById('prior-work-section')?.hidden).toBe(false);
    expect(document.getElementById('portfolio-section')?.hidden).toBe(false);
  });

  it('exactly one chip carries aria-pressed=true at a time', async () => {
    const document = await render();
    const claimsChip = document.querySelector('[data-bucket="claim"]') as HTMLButtonElement | null;
    claimsChip!.click();

    const pressed = Array.from(document.querySelectorAll('#history-filters .chip[aria-pressed="true"]'));
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toBe(claimsChip);
  });

  it('the chip labels carry live counts matching the rows actually rendered', async () => {
    const document = await render();
    const hireCount = document.getElementById('history')?.children.length ?? -1;
    const priorCount = document.getElementById('prior-work')?.children.length ?? -1;
    const claimCount = document.getElementById('portfolio')?.children.length ?? -1;

    expect(hireCount).toBe(1);
    expect(claimCount).toBe(1);

    const allChip = document.querySelector('[data-bucket="all"]');
    const hiresChip = document.querySelector('[data-bucket="hire"]');
    const priorChip = document.querySelector('[data-bucket="prior"]');
    const claimsChip = document.querySelector('[data-bucket="claim"]');

    expect(allChip?.textContent).toContain(String(hireCount + priorCount + claimCount));
    expect(hiresChip?.textContent).toContain(String(hireCount));
    expect(priorChip?.textContent).toContain(String(priorCount));
    expect(claimsChip?.textContent).toContain(String(claimCount));
  });
});

describe('the record line names verified prior work and unchecked claims (wireframe agent.html)', () => {
  it('states both counts, never a percentage', async () => {
    const document = await render();
    const recordLine = document.getElementById('record-line')?.textContent ?? '';
    const priorCount = document.getElementById('prior-work')?.children.length ?? -1;
    const claimCount = document.getElementById('portfolio')?.children.length ?? -1;

    expect(recordLine).toContain(`${priorCount} verified prior work`);
    expect(recordLine).toContain(String(claimCount));
    expect(recordLine).not.toMatch(/%/);
  });
});

describe('"What it works on" renders honest facts (wireframe agent.html)', () => {
  it('renders "not yet observed" for every derived stat this API does not yet expose', async () => {
    const document = await render();
    for (const id of ['fact-typical-change', 'fact-median-time-to-pr', 'fact-merge-rate', 'fact-languages-seen']) {
      expect(document.getElementById(id)?.textContent).toBe('not yet observed');
    }
  });

  it('renders "Listed since" from the agent record that already loaded', async () => {
    const document = await render();
    const listedSince = document.getElementById('fact-listed-since')?.textContent ?? '';
    expect(listedSince.length).toBeGreaterThan(0);
    expect(listedSince).not.toBe('not yet observed');
  });
});

// Round 2 (Proof FAIL, commit a7fbb89): D1 conformance-satisfied-by-dead-markup
// and D2 wireframe-element-absent. Both fixed at the row-rendering level
// (agent.js's tierRow), never by widening the conformance test's string
// scan: a verified-hire row now carries the wireframe's own verify wording,
// its diff size and job id (DATA-CONTRACT section 4, now readable off
// CredentialEvidence's additions/deletions/filesChanged, R-17), and a claim
// row carries the wireframe's "We cannot check this." sentence beside the
// verify link's absence (MISSION invariant 4).
describe('verified-hire and claim rows carry the wireframe row shape (Proof round 2, D1/D2)', () => {
  it('a verified-hire row\'s verify affordance reads the wireframe\'s own wording, "Verify this credential"', async () => {
    const document = await render();
    const hireRow = document.getElementById('history')?.firstElementChild;
    const verify = hireRow?.querySelector('.verify');
    expect(verify?.textContent).toBe('Verify this credential');
  });

  it('a verified-hire row carries +added/-removed, N files, and its job id (DATA-CONTRACT section 4)', async () => {
    const document = await render();
    const hireRow = document.getElementById('history')?.firstElementChild;
    const meta = hireRow?.querySelector('.meta')?.textContent ?? '';
    expect(meta).toContain('+10 / -2, 1 file');
    expect(meta).toContain('job tabs-job-hire');
  });

  it('a portfolio claim row carries "We cannot check this." and no verify affordance (MISSION invariant 4)', async () => {
    const document = await render();
    const claimRow = document.getElementById('portfolio')?.firstElementChild;
    expect(claimRow?.textContent).toContain('We cannot check this.');
    expect(claimRow?.querySelector('.verify')).toBeNull();
  });

  it('a verified-hire row carries no "We cannot check this." sentence (the absence is claim-only)', async () => {
    const document = await render();
    const hireRow = document.getElementById('history')?.firstElementChild;
    expect(hireRow?.textContent ?? '').not.toContain('We cannot check this.');
  });
});
