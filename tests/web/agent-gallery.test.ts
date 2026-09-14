// W8 Proof round 1, D1 (gallery-claim-tier-missing): the Portfolio gallery
// (spec/wireframe/agent.html lines 272-422, gallery.css) renders three
// tiers, not two. A verified hire and verified prior-work item earn a real
// preview frame and a link row; a portfolio claim earns NEITHER, and the
// wireframe draws that absence as its own card
// (figure.work.is-claim > div.work-frame.is-empty) rather than omitting the
// item from the panel altogether. ENT-12.1: "the absence of the verify
// control IS the message" only lands if the card is there to lack it.
//
// Same rendering harness as tests/web/agent-work-history-tabs.test.ts: jsdom
// loads the served page, lets its own script run, and the assertions read
// the DOM a visitor is left looking at.
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

const OPERATOR_DID = 'did:abt:zGalleryOperator';
const AGENT_DID = 'did:abt:zGalleryAgent';

function delegation(agentDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:gallery-${agentDid}`,
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
          buyer: 'did:example:gallery-buyer',
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
    buyerDid: 'did:example:gallery-buyer',
    repository: 'buyer/gallery-repo',
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
    name: 'gallery-agent',
    skills: ['react'],
    githubLogin: null,
  });

  // One verified hire (public repo, merged) and one portfolio claim
  // (private repo, merged, demoted by invariant 4): the gallery must
  // render one real card and one honest-empty claim card, never zero
  // claim cards for a claim that exists.
  const hireDraft = jobFixture({ id: 'gallery-job-hire', agentDid: AGENT_DID });
  await jobRepo.create(hireDraft);
  await jobRepo.complete(
    { ...hireDraft, status: 'completed', mergeCommit: 'galleryhire', mergedAt: new Date('2026-08-30T00:00:00Z') },
    { jobId: hireDraft.id, buyerDid: hireDraft.buyerDid, agentDid: AGENT_DID, mergeCommit: 'galleryhire', completedAt: new Date('2026-08-30T00:00:00Z') },
  );
  await credentialRepo.save(
    credentialDoc('https://platform.example/v1/credentials/gallery-job-hire', AGENT_DID, 'buyer/gallery-repo-a', 'galleryhire', true),
  );

  const claimDraft = jobFixture({ id: 'gallery-job-claim', agentDid: AGENT_DID });
  await jobRepo.create(claimDraft);
  await jobRepo.complete(
    { ...claimDraft, status: 'completed', mergeCommit: 'galleryclaim', mergedAt: new Date('2026-08-30T00:00:00Z') },
    { jobId: claimDraft.id, buyerDid: claimDraft.buyerDid, agentDid: AGENT_DID, mergeCommit: 'galleryclaim', completedAt: new Date('2026-08-30T00:00:00Z') },
  );
  await credentialRepo.save(
    credentialDoc('https://platform.example/v1/credentials/gallery-job-claim', AGENT_DID, 'buyer/gallery-repo-b', 'galleryclaim', false),
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

describe('the Portfolio gallery renders every tier, including a claim (wireframe agent.html, ENT-12.1)', () => {
  it('renders one figure per item, a real card for the hire and an empty-frame card for the claim', async () => {
    const document = await render();
    const figures = document.querySelectorAll('#gallery > figure.work');
    expect(figures).toHaveLength(2);
  });

  it('the claim card carries figure.work.is-claim with the empty frame and no verify affordance', async () => {
    const document = await render();
    const claimFigure = document.querySelector('#gallery > figure.work.is-claim');
    expect(claimFigure).not.toBeNull();

    const emptyFrame = claimFigure!.querySelector('.work-frame.is-empty');
    expect(emptyFrame).not.toBeNull();

    expect(claimFigure!.textContent).toContain('No preview. We have not seen this work.');
    expect(claimFigure!.textContent).toContain('Anyone can write this. Treat it as a description, not a record.');

    // ENT-12.1: the absence of the control IS the message. No link row.
    expect(claimFigure!.querySelectorAll('a')).toHaveLength(0);
  });

  it('the hire card is not marked as a claim and carries no empty frame', async () => {
    const document = await render();
    const hireFigure = document.querySelector('#gallery > figure.work:not(.is-claim)');
    expect(hireFigure).not.toBeNull();
    expect(hireFigure!.querySelector('.work-frame.is-empty')).toBeNull();
  });

  // Proof round 2, D3 (gallery-tier-label-missing): the wireframe puts a
  // tier badge in every card's div.work-head beside the title (lines 296,
  // 321, 348, 379, 409) and closes the panel with a p.callout-sm sentence
  // naming the rule. A dashed border alone does not say which tier a card
  // is in or why the difference exists; the label is what makes the
  // absence of a preview read as a message rather than a missing asset.
  it('the hire card carries a "Verified hire" tier badge in its work-head', async () => {
    const document = await render();
    const hireFigure = document.querySelector('#gallery > figure.work:not(.is-claim)');
    expect(hireFigure).not.toBeNull();
    const badge = hireFigure!.querySelector('.work-head .pverified.pverified-sm');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('Verified hire');
  });

  it('the claim card carries a "Portfolio claim" tier badge in its work-head', async () => {
    const document = await render();
    const claimFigure = document.querySelector('#gallery > figure.work.is-claim');
    expect(claimFigure).not.toBeNull();
    const badge = claimFigure!.querySelector('.work-head .tier.tier-claim');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('Portfolio claim');
  });

  it('the panel closes with the callout naming the rule that gates a preview', async () => {
    const document = await render();
    const callout = document.querySelector('#tab-portfolio .callout-sm');
    expect(callout).not.toBeNull();
    expect(callout!.textContent).toContain('A preview is earned by a public repository');
  });

  // Proof round 3, D4 (count-noun-disagreement): the hero badge hardcodes
  // the plural noun in markup while the script sets only the digit, so an
  // agent with exactly one verified hire reads "1 verified hires" even
  // though p.lede on the same screen correctly reads "1 verified hire".
  // api.js's A.plural exists precisely so a count and its noun agree; this
  // fixture has exactly one verified hire, which is the case that breaks.
  it('the hero badge agrees the noun with a singular verified-hire count', async () => {
    const document = await render();
    const badge = document.querySelector('#pverified-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('1 verified hire');
    expect(badge!.textContent).not.toContain('1 verified hires');
  });
});
