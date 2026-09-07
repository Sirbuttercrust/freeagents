// P8j: the staged screen, driven end to end against the real app (the
// discipline tests/web/deposit.test.ts and tests/web/agreement.test.ts
// already hold to). Every route the wireframe wires up is exercised for
// real: GET /jobs/:jobId/attestation against a real signed attestation,
// POST .../payments/remainder/abt/start against a real ABT rail and a
// real DID Connect session, never asserted from a client-side stub.
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryAttestationRepository,
  MemoryCredentialRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job, LAPSE_AT_STAGED_AFTER_DAYS, REDO_LAPSE_EXTENSION_DAYS } from '../../src/domain/job.js';
import { buildAttestation, type StagingObservation, type Attestation } from '../../src/domain/attestation.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { ABT_FEE_RATE_PERCENT, calculateFee, remainderUsd } from '../../src/domain/payment.js';
import { didSuffix } from '../../src/domain/agent.js';
import { createAbtPaymentRail } from '../../src/adapters/payment/abt.js';
import { fromRandom } from '@ocap/wallet';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { unsettledGate } from '../helpers/settlement-fixtures.js';
import { abtEnv, fakeAbtChainClient, reservePort, withEnv } from '../helpers/abt-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:staged-page-agent';
const HIRED_AGENT_DID = 'did:abt:staged-page-hired-agent';
const BUYER_ACCOUNT_DID = 'did:abt:staged-page-buyer-account';
const STRANGER_ACCOUNT_DID = 'did:abt:staged-page-stranger-account';
const OPERATOR_DID = 'did:abt:staged-page-operator';

// Recent, not hardcoded: GET /jobs/:jobId runs the live lapse clocks on
// every read (applyLiveLapses, src/api/app.ts). A stagedAt more than
// LAPSE_AT_STAGED_AFTER_DAYS old would flip the fixture's own status
// before this file ever gets to assert on it.
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

function delegationFixture(did: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: did },
    proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${did}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture-not-verified-here' },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string }): Job {
  const base = createJob(
    { id: overrides.id, buyerDid: BUYER_ACCOUNT_DID, agentDid: AGENT_DID, repository: 'buyer/staged-repo', brief: 'Fix the checkout flow' },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

const NINE_PATHS = [
  'packages/tokens/src/index.ts',
  'packages/tokens/src/colour.ts',
  'packages/tokens/src/space.ts',
  'packages/tokens/test/duplicate.test.ts',
  'packages/ui/src/tokens.ts',
  'packages/ui/src/index.ts',
  'packages/theme/src/tokens.ts',
  'packages/theme/src/index.ts',
  'README.md',
];

function observationFixture(overrides: Partial<StagingObservation> = {}): StagingObservation {
  return {
    diffHash: 'sha256:fixture-diff-hash',
    filesChanged: 9,
    linesAdded: 186,
    linesRemoved: 94,
    changedPaths: NINE_PATHS,
    lineShareByCategory: { source: 61, test: 27, lockfile: 0, generated: 0, vendored: 0 },
    testsDeleted: [],
    testsSkipAdded: ['packages/ui/test/legacy-import.test.ts', 'packages/theme/test/legacy-import.test.ts'],
    // Ruling 2: always equal to filesChanged in the real system
    // (criteriaPaths: [] at the call site); carried on the fixture so a
    // test that accidentally renders it is not trivially passing by
    // omission.
    outOfCriteriaPathCount: 9,
    commitSigners: [{ matchesAgentDid: true }, { matchesAgentDid: true }, { matchesAgentDid: true }, { matchesAgentDid: true }],
    ...overrides,
  };
}

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}

// Generic renderer: fetches path over HTTP with an HTML Accept header,
// hydrates it in jsdom with scripts running, and waits for the page's own
// async work to settle. onFetch, when given, observes every request the
// page makes (method and raw input) BEFORE it is dispatched, installed
// before any page script runs, so an on-load call is captured and not
// only whatever fires later (mutation proofs 11 and D3's own requirement).
async function renderPage(
  baseUrl: string,
  path: string,
  session: { token: string } | null,
  onFetch?: (input: string, init?: RequestInit) => void,
): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  const markup = await response.text();
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (session !== null) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          if (onFetch) onFetch(input, init);
          return fetch(new URL(input, baseUrl), init);
        },
      });
    },
  });

  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}

function renderStaged(
  baseUrl: string,
  jobId: string,
  session: { token: string } | null,
  onFetch?: (input: string, init?: RequestInit) => void,
): Promise<Rendered> {
  return renderPage(baseUrl, `/staged?job=${encodeURIComponent(jobId)}`, session, onFetch);
}

describe('the staged screen, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let accountRepo: MemoryAccountRepository;
  let attestationRepo: MemoryAttestationRepository;
  let server: Server;
  let baseUrl: string;
  let buyerToken: string;

  async function storeAttestation(job: Job, observation: StagingObservation, credentials: ReturnType<typeof createCredentialsAdapter>): Promise<Attestation> {
    const attestation = buildAttestation(job, observation, RECENT);
    const signed = await credentials.signAttestation(attestation);
    await attestationRepo.save({ jobId: job.id, attestation, signed });
    return attestation;
  }

  beforeAll(async () => {
    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: OPERATOR_DID,
      delegation: delegationFixture(AGENT_DID, OPERATOR_DID),
      name: 'staged-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });

    accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'staged-page-buyer' });
    await accountRepo.register({ did: STRANGER_ACCOUNT_DID, githubLogin: 'staged-page-stranger' });
    await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'staged-page-operator-login' });

    jobRepo = new MemoryJobRepository();
    attestationRepo = new MemoryAttestationRepository();
    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter(undefined, credentialRepo);

    // Fully staged, the screen this card builds.
    const fullyStaged = jobFixture({
      id: 'job-fully-staged',
      status: 'staged',
      criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      priceUsd: '1200.00',
      rail: 'abt',
      depositPercent: 25,
      redoAllowance: 1,
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      stagedAt: RECENT,
      stagedCommit: 'c41f8a9d2b73e05614af8c3d99b7e2016fa4d825',
    });
    await jobRepo.create(fullyStaged);
    await storeAttestation(fullyStaged, observationFixture(), credentials);

    // The half-up tie case payment.ts itself pins on the REMAINDER:
    // priceUsd 2.00 at depositPercent 75 leaves a remainder of exactly
    // 0.50, and 0.50 at 3 percent is exactly 0.0150, the tie ruling 5's
    // own drift test needs.
    const tieCase = jobFixture({ id: 'job-tie-case', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '2.00', rail: 'abt', depositPercent: 75, priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-tie-case' });
    await jobRepo.create(tieCase);
    await storeAttestation(tieCase, observationFixture({ diffHash: 'sha256:tie-case' }), credentials);

    // Not staged: a job at confirmed, for the not-ready panel.
    await jobRepo.create(jobFixture({ id: 'job-confirmed-not-staged', status: 'confirmed', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true }));

    // redo_requested: a distinct not-ready sentence, ruling 7.
    await jobRepo.create(jobFixture({ id: 'job-redo-requested', status: 'redo_requested', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-redo-requested', redoRequestedCriterionIndex: 0, redoRequestedAt: RECENT }));

    // A stranger's 403 fixture.
    await jobRepo.create(jobFixture({ id: 'job-for-403', status: 'staged', criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '100.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-for-403' }));
    await storeAttestation(
      await jobRepo.findById('job-for-403') as Job,
      observationFixture({ diffHash: 'sha256:for-403' }),
      credentials,
    );

    // Staged with NO attestation stored: the fault leg, distinct from a
    // 404 on the job itself.
    await jobRepo.create(jobFixture({ id: 'job-no-attestation', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-no-attestation' }));

    // A restaged job that HAS had an accepted redo: stagedLapseExtensionDays
    // is non-zero, and the redo object rides the projection.
    const redoneJob = jobFixture({ id: 'job-redone-once', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-redone', redoRequestedCriterionIndex: 0, redoRequestedAt: new Date(RECENT.getTime() - 1000), redoUsedCount: 1, stagedLapseExtensionDays: REDO_LAPSE_EXTENSION_DAYS });
    await jobRepo.create(redoneJob);
    await storeAttestation(redoneJob, observationFixture({ diffHash: 'sha256:redone' }), credentials);

    // D1 (deposit.test.ts's own pattern): a SEPARATE agent with a
    // completed hire, for the verified-hire-count assertion.
    await agentRepo.create({ did: HIRED_AGENT_DID, operatorDid: 'did:abt:staged-page-hired-operator', delegation: delegationFixture(HIRED_AGENT_DID, 'did:abt:staged-page-hired-operator'), name: 'staged-page-hired-scout', skills: ['triage'], githubLogin: null });
    const completedHireDraft = jobFixture({ id: 'staged-page-completed-hire', buyerDid: 'did:example:staged-page-past-buyer', agentDid: HIRED_AGENT_DID, status: 'draft' });
    await jobRepo.create(completedHireDraft);
    await jobRepo.complete(
      { ...completedHireDraft, status: 'completed', mergeCommit: 'staged-page-commit-1', mergedAt: new Date('2026-08-30T00:00:00Z') },
      { jobId: completedHireDraft.id, buyerDid: completedHireDraft.buyerDid, agentDid: HIRED_AGENT_DID, mergeCommit: 'staged-page-commit-1', completedAt: new Date('2026-08-30T00:00:00Z') },
    );
    const hiredAgentStaged = jobFixture({ id: 'job-hired-agent-has-hires', agentDid: HIRED_AGENT_DID, status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '500.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-hired-agent' });
    await jobRepo.create(hiredAgentStaged);
    await storeAttestation(hiredAgentStaged, observationFixture({ diffHash: 'sha256:hired-agent' }), credentials);

    // Markup in a changed path and a test name: literal text, never
    // parsed (api.js rule 3).
    const markupJob = jobFixture({ id: 'job-markup', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '150.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-markup' });
    await jobRepo.create(markupJob);
    await storeAttestation(
      markupJob,
      observationFixture({
        changedPaths: ['<img src=x onerror=alert(1)>evil.ts'],
        testsSkipAdded: ['<script>alert(1)</script>.test.ts'],
      }),
      credentials,
    );

    // For the pull-request re-read control: staged, but with
    // pullRequestUrl/submittedAt already present on the row (simulating
    // the agent having submitted while the buyer's dialog sat open).
    const withPr = jobFixture({ id: 'job-with-pr', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-with-pr', pullRequestUrl: 'https://github.com/buyer/staged-repo/pull/9', submittedAt: RECENT });
    await jobRepo.create(withPr);
    await storeAttestation(withPr, observationFixture({ diffHash: 'sha256:with-pr' }), credentials);

    const sessionAdapterRef = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'staged-page-buyer', id: 9401 }) });

    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, credentials, undefined, credentialRepo, undefined, undefined, undefined, sessionAdapterRef, undefined, unsettledGate(), undefined, attestationRepo);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    buyerToken = await mintSessionToken(sessionAdapterRef);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('a signed-out visitor, an unknown job id, and a staged job with no attestation on record', () => {
    it('each renders its own readable panel, never a blank screen', async () => {
      const signedOut = await renderStaged(baseUrl, 'job-fully-staged', null);
      const unknownJob = await renderStaged(baseUrl, 'no-such-job', { token: buyerToken });
      const noAttestation = await renderStaged(baseUrl, 'job-no-attestation', { token: buyerToken });
      try {
        const notice = signedOut.document.getElementById('signin-required');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
        expect((notice!.textContent ?? '').toLowerCase()).toContain('sign in');
        expect(signedOut.document.getElementById('staged-body')!.hidden).toBe(true);

        const loadError = unknownJob.document.getElementById('load-error');
        expect(loadError).not.toBeNull();
        expect(loadError!.hidden).toBe(false);

        const fault = noAttestation.document.getElementById('fault-error');
        expect(fault).not.toBeNull();
        expect(fault!.hidden).toBe(false);
      } finally {
        signedOut.close();
        unknownJob.close();
        noAttestation.close();
      }
    });
  });

  describe('a stranger to the job', () => {
    it('is refused with the 403 sentence, not a blank screen', async () => {
      const strangerAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'staged-page-stranger', id: 9402 }) });
      const strangerAccountRepo = new MemoryAccountRepository();
      await strangerAccountRepo.register({ did: STRANGER_ACCOUNT_DID, githubLogin: 'staged-page-stranger' });
      const strangerServer = createApp(strangerAccountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, strangerAdapter, undefined, unsettledGate(), undefined, attestationRepo).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => strangerServer.once('listening', resolve));
      const strangerBaseUrl = `http://127.0.0.1:${(strangerServer.address() as AddressInfo).port}`;
      try {
        const token = await mintSessionToken(strangerAdapter);
        const page = await renderStaged(strangerBaseUrl, 'job-for-403', { token });
        try {
          const notice = page.document.getElementById('party-error');
          expect(notice).not.toBeNull();
          expect(notice!.hidden).toBe(false);
          const body = page.document.getElementById('staged-body');
          expect(body!.hidden).toBe(true);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => strangerServer.close(() => resolve()));
      }
    });
  });

  describe('a job not at staged (ruling 7, mutation proof 7)', () => {
    it('a confirmed job renders the not-ready panel with a link back to /jobs/<id>, and no pay control', async () => {
      const page = await renderStaged(baseUrl, 'job-confirmed-not-staged', { token: buyerToken });
      try {
        const notice = page.document.getElementById('not-ready-error');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
        const link = page.document.getElementById('not-ready-link') as HTMLAnchorElement | null;
        expect(link?.getAttribute('href')).toBe('/jobs/job-confirmed-not-staged');
        const body = page.document.getElementById('staged-body');
        expect(body!.hidden).toBe(true);
      } finally {
        page.close();
      }
    });

    it('a redo_requested job renders its own distinct not-ready sentence', async () => {
      const page = await renderStaged(baseUrl, 'job-redo-requested', { token: buyerToken });
      try {
        const detail = page.document.getElementById('not-ready-detail')?.textContent ?? '';
        expect(detail.toLowerCase()).toContain('redo');
      } finally {
        page.close();
      }
    });
  });

  describe('the account of the work: six facts, same weight, fixed order, ruling 2 omitted', () => {
    it('renders exactly six fact rows in the fixed order, with the full path list untruncated, one shared class vocabulary, and no test-vocabulary anywhere (mutation proofs 5, 6)', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken });
      try {
        const rows = page.document.querySelectorAll('#facts > li');
        expect(rows.length).toBe(6);
        const labels = Array.from(rows).map((row) => row.querySelector('.f')?.textContent ?? '');
        expect(labels).toEqual([
          'Files changed',
          'Lines',
          'Where the changes are',
          'Tests deleted',
          'Tests newly skipped',
          'Commits signed by the agent',
        ]);
        // No row's label or value ever mentions the outside-agreed-paths
        // concept, in any wording (ruling 2). No row carries a colour,
        // badge or per-row distinction (facts, no verdict).
        Array.from(rows).forEach((row) => {
          expect(row.className).toBe('');
          expect(row.querySelector('[class*="warn"]')).toBeNull();
          expect(row.querySelector('[class*="danger"]')).toBeNull();
          expect(row.querySelector('[class*="bad"]')).toBeNull();
        });
        const wholeText = (page.document.getElementById('facts')?.textContent ?? '').toLowerCase();
        expect(wholeText).not.toContain('outside');
        expect(wholeText).not.toContain('agreed paths');

        const paths = page.document.querySelectorAll('#facts .paths')[0]?.querySelectorAll('li') ?? [];
        expect(paths.length).toBe(NINE_PATHS.length);
        NINE_PATHS.forEach((p) => {
          const text = Array.from(paths).map((li) => li.textContent);
          expect(text).toContain(p);
        });

        const mainText = (page.document.querySelector('main')?.textContent ?? '').toLowerCase();
        expect(mainText).not.toContain('test command');
        expect(mainText).not.toContain('tests passed');
        expect(mainText).not.toContain('tests failed');
      } finally {
        page.close();
      }
    });

    it('a changed path or test name containing markup renders as literal text (api.js rule 3)', async () => {
      const page = await renderStaged(baseUrl, 'job-markup', { token: buyerToken });
      try {
        expect(page.document.querySelector('#facts img')).toBeNull();
        expect(page.document.querySelector('#facts script')).toBeNull();
        const text = page.document.getElementById('facts')?.textContent ?? '';
        expect(text).toContain('<img src=x onerror=alert(1)>evil.ts');
        expect(text).toContain('<script>alert(1)</script>.test.ts');
      } finally {
        page.close();
      }
    });
  });

  describe('the clock (ruling 4, mutation proofs 1 and 2)', () => {
    it('states the deadline as stagedAt plus LAPSE_AT_STAGED_AFTER_DAYS for a job never redone, with no draining bar or countdown element', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken });
      try {
        const expectedDeadline = new Date(RECENT.getTime() + LAPSE_AT_STAGED_AFTER_DAYS * 86_400_000);
        const days = page.document.getElementById('clock-days')?.textContent ?? '';
        expect(days).toContain(String(LAPSE_AT_STAGED_AFTER_DAYS) + ' days');
        expect(days).toContain(expectedDeadline.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
        const then = page.document.getElementById('clock-then')?.textContent ?? '';
        expect(then.toLowerCase()).toContain('nothing further is charged');
        expect(page.document.querySelector('progress')).toBeNull();
        expect(page.document.querySelector('[role="progressbar"]')).toBeNull();
      } finally {
        page.close();
      }
    });

    it('states the deadline as stagedAt plus LAPSE_AT_STAGED_AFTER_DAYS plus the stored extension for a redone job', async () => {
      const page = await renderStaged(baseUrl, 'job-redone-once', { token: buyerToken });
      try {
        const expectedDeadline = new Date(RECENT.getTime() + (LAPSE_AT_STAGED_AFTER_DAYS + REDO_LAPSE_EXTENSION_DAYS) * 86_400_000);
        const days = page.document.getElementById('clock-days')?.textContent ?? '';
        expect(days).toContain(String(LAPSE_AT_STAGED_AFTER_DAYS + REDO_LAPSE_EXTENSION_DAYS) + ' days');
        expect(days).toContain(expectedDeadline.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
      } finally {
        page.close();
      }
    });
  });

  describe('the three choices, computed from the projection and pinned against src/domain/payment.ts', () => {
    it('the pay amount, fee and total agree with remainderUsd/calculateFee, all three choices render as prose with no button for redo or decline, and the pay button is the only acting control (ruling 1, mutation proof 13, mutation proofs 3, 4)', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken });
      try {
        const remainder = remainderUsd('1200.00', 25);
        const fee = calculateFee(remainder, ABT_FEE_RATE_PERCENT);
        const total = (parseFloat(remainder) + parseFloat(fee)).toFixed(2);
        const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
        expect(payBtn.textContent).toContain(`$${total}`);

        const choices = page.document.querySelectorAll('#choices > li');
        expect(choices.length).toBe(3);
        const payRow = choices[0];
        expect(payRow?.querySelector('.v')?.textContent).toBe(`$${total}`);
        expect(payRow?.querySelector('.para')?.textContent ?? '').toContain(`$${parseFloat(remainder).toFixed(2)}`);
        expect(choices[1]?.querySelector('.k')?.textContent).toContain('Send it back');
        expect(choices[1]?.querySelector('button')).toBeNull();
        expect(choices[1]?.querySelector('a')).toBeNull();
        expect(choices[2]?.querySelector('.k')?.textContent).toContain('Decline');
        expect(choices[2]?.querySelector('button')).toBeNull();
        expect(choices[2]?.querySelector('a')).toBeNull();

        // Exactly one button on the primary surface issues a network
        // request: the pay control (mutation proof 13). The disclose
        // control and the copy buttons do not themselves post anywhere.
        const main = page.document.querySelector('main');
        const buttons = Array.from(main?.querySelectorAll('button') ?? []);
        const actingButtons = buttons.filter((b) => b.id === 'pay-btn');
        expect(actingButtons.length).toBe(1);
        buttons.forEach((b) => {
          expect(['pay-btn', undefined].includes(b.id) || b.classList.contains('disclose') || b.hasAttribute('data-copy')).toBe(true);
        });
      } finally {
        page.close();
      }
    });

    it('the half-up tie case (a $0.50 remainder at 3 percent) matches payment.ts exactly (mutation proof 4)', async () => {
      const page = await renderStaged(baseUrl, 'job-tie-case', { token: buyerToken });
      try {
        const remainder = remainderUsd('2.00', 75);
        expect(remainder).toBe('0.50');
        const fee = calculateFee(remainder, ABT_FEE_RATE_PERCENT);
        expect(fee).toBe('0.02');
        const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
        expect(payBtn.textContent).toContain('$0.52');
      } finally {
        page.close();
      }
    });
  });

  describe('the technical disclosure', () => {
    it('the staged commit and diffHash render behind the disclosure with copy controls, and the line share sums to 100 including other', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken });
      try {
        expect(page.document.getElementById('tech-staged-commit')?.textContent).toBe('c41f8a9d2b73e05614af8c3d99b7e2016fa4d825');
        expect(page.document.getElementById('tech-diff-hash')?.textContent).toBe('sha256:fixture-diff-hash');
        const share = page.document.getElementById('tech-line-share')?.textContent ?? '';
        expect(share).toContain('source 61 percent');
        expect(share).toContain('other 12 percent');
      } finally {
        page.close();
      }
    });
  });

  describe('the verified hire count (scope item 9)', () => {
    it('renders the agent name with no count when the agent has none', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken });
      try {
        expect(page.document.getElementById('agent-name')?.textContent).toBe('staged-page-scout');
        expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('');
      } finally {
        page.close();
      }
    });

    it('renders the real count from GET /agents/:agentDid/hires when the agent has a verified hire', async () => {
      const page = await renderStaged(baseUrl, 'job-hired-agent-has-hires', { token: buyerToken });
      try {
        expect(page.document.getElementById('agent-name')?.textContent).toBe('staged-page-hired-scout');
        expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('1 verified hire');
      } finally {
        page.close();
      }
    });

    it('renders the agent name with no count when the hires read fails', async () => {
      const realPort = (server.address() as AddressInfo).port;
      const proxy = http.createServer((req, res) => {
        if (req.url !== undefined && /\/agents\/[^/]+\/hires$/.test(req.url)) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'storage unavailable' }));
          return;
        }
        const upstream = http.request({ hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers }, (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        });
        req.pipe(upstream);
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyBaseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      try {
        const page = await renderStaged(proxyBaseUrl, 'job-hired-agent-has-hires', { token: buyerToken });
        expect(page.document.getElementById('agent-name')?.textContent).toBe('staged-page-hired-scout');
        expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('');
        page.close();
      } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    });
  });

  describe('the session token never rides in the document, and the nav flips to signed-in (constraint: no cookie, no URL)', () => {
    it('the token does not appear anywhere in the rendered document, including inside the dialog, and the nav shows signed-in', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken });
      try {
        expect(page.document.documentElement.outerHTML).not.toContain(buyerToken);
        const signedIn = page.document.getElementById('nav-signed-in');
        expect(signedIn?.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('the ABT pay control posts to the remainder leg only and opens the scan (scope items 3 and 5, mutation proofs 9, 10)', () => {
    it('posts exactly once to the remainder leg, never the deposit leg, and the scan URL is byte-identical to what the route answered', async () => {
      const fakeChain = fakeAbtChainClient(true);
      const port = await reservePort();
      const abtBaseUrl = `http://127.0.0.1:${port}`;
      const platformWallet = fromRandom();
      const env = abtEnv(abtBaseUrl, platformWallet, fromRandom().address, fromRandom().address);
      const started = await withEnv(env, async () => {
        const abtOperatorRepo = new MemoryAccountRepository();
        await abtOperatorRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'staged-abt-buyer' });
        await abtOperatorRepo.register({ did: OPERATOR_DID, githubLogin: 'staged-abt-operator' });
        await abtOperatorRepo.setOperatorAddressAbt(OPERATOR_DID, didSuffix(AGENT_DID));
        const abtAgentRepo = new MemoryAgentRepository();
        await abtAgentRepo.create({ did: AGENT_DID, operatorDid: OPERATOR_DID, delegation: delegationFixture(AGENT_DID, OPERATOR_DID), name: 'staged-abt-scout', skills: ['triage'], githubLogin: null });
        const abtJobRepo = new MemoryJobRepository();
        const abtAttestationRepo = new MemoryAttestationRepository();
        const abtCredentialRepo = new MemoryCredentialRepository();
        const abtCredentials = createCredentialsAdapter(undefined, abtCredentialRepo);
        const abtJob = jobFixture({ id: 'job-abt-pay', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '600.00', rail: 'abt', depositPercent: 25, priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-abt-pay' });
        await abtJobRepo.create(abtJob);
        const attestation = buildAttestation(abtJob, observationFixture({ diffHash: 'sha256:abt-pay' }), RECENT);
        const signed = await abtCredentials.signAttestation(attestation);
        await abtAttestationRepo.save({ jobId: abtJob.id, attestation, signed });

        const spentTransferRows = new Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>();
        const spentTransferStorage = {
          async record(row: { hash: string; jobId: string; leg: 'deposit' | 'balance' }): Promise<void> {
            spentTransferRows.set(row.hash, { ...row });
          },
          async findByHash(hash: string) {
            return spentTransferRows.get(hash) ?? null;
          },
        };
        const abtRail = createAbtPaymentRail({ chainClient: fakeChain.client, rateSource: async () => '1', spentTransferStorage });
        const sessionAdapterRef = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'staged-abt-buyer', id: 9501 }) });
        const app = createApp(abtOperatorRepo, abtAgentRepo, undefined, undefined, abtJobRepo, abtCredentials, undefined, abtCredentialRepo, undefined, undefined, undefined, sessionAdapterRef, undefined, unsettledGate(), undefined, abtAttestationRepo, abtRail);
        const abtServer = app.listen(port, '127.0.0.1');
        await new Promise<void>((resolve) => abtServer.once('listening', resolve));
        const token = await mintSessionToken(sessionAdapterRef);
        return { abtServer, token, jobId: abtJob.id };
      });

      try {
        const page = await renderStaged(abtBaseUrl, started.jobId, { token: started.token });
        try {
          let remainderCalls = 0;
          let depositCalls = 0;
          let observedUrl = '';
          const originalFetch = global.fetch;
          Object.defineProperty(page.window, 'fetch', {
            writable: true,
            value: async (input: string, init?: RequestInit) => {
              const response = await originalFetch(new URL(input, abtBaseUrl), init);
              if (String(input).includes('/payments/remainder/abt/start')) {
                remainderCalls += 1;
                const cloned = response.clone();
                const body = (await cloned.json()) as { url: string };
                observedUrl = body.url;
              }
              if (String(input).includes('/payments/deposit/')) depositCalls += 1;
              return response;
            },
          });

          const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
          expect(payBtn.disabled).toBe(false);
          payBtn.click();
          await new Promise((resolve) => setTimeout(resolve, 250));

          expect(remainderCalls).toBe(1);
          expect(depositCalls).toBe(0);
          const scanUrl = (page.document.getElementById('scan-url') as HTMLInputElement | null)?.value ?? '';
          expect(scanUrl).not.toBe('');
          expect(scanUrl).toBe(observedUrl);

          const dialog = page.document.getElementById('scan') as HTMLDialogElement;
          expect(dialog.hasAttribute('open')).toBe(true);

          // No settlement claim (ruling 6, mutation proof 12).
          const status = page.document.getElementById('scan-status')?.textContent?.toLowerCase() ?? '';
          expect(status).not.toContain('cleared');
          expect(status).not.toContain('payment received');
          expect(status).not.toContain('success');
          expect(status).toContain('wallet');

          const abtJobAfter = await (async () => {
            const res = await fetch(`${abtBaseUrl}/jobs/${started.jobId}`, { headers: { Accept: 'application/json' } });
            return (await res.json()) as { status: string };
          })();
          expect(abtJobAfter.status).toBe('staged');
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => started.abtServer.close(() => resolve()));
      }
    });
  });

  describe('the pull-request re-read control fires only on a press, never on load (ruling 6, mutation proof 11)', () => {
    it('the call count is zero until pressed, and the link renders once pullRequestUrl is present', async () => {
      let getJobCalls = 0;
      const page = await renderStaged(baseUrl, 'job-with-pr', { token: buyerToken }, (input) => {
        if (/\/jobs\/job-with-pr$/.test(String(input))) getJobCalls += 1;
      });
      try {
        // Exactly one GET /jobs/:jobId happens on load (the page's own
        // Promise.all read used to render itself). Mutation proof 11:
        // an extra read anywhere else in the load path (e.g. inside
        // renderWho) must turn this into a red test, not just the
        // click-delta below.
        expect(getJobCalls).toBe(1);
        const checkBtn = page.document.getElementById('check-pr-btn') as HTMLButtonElement;
        checkBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(getJobCalls).toBe(2);
        const link = page.document.getElementById('scan-pr-link') as HTMLAnchorElement | null;
        expect(link?.getAttribute('href')).toBe('https://github.com/buyer/staged-repo/pull/9');
        const wrap = page.document.getElementById('scan-pr-wrap');
        expect(wrap?.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('the full set of requests the page makes, recorded from before the first script runs (scope items 3/5, done-means: "assert by recording every request the page makes")', () => {
    it('on load the page reads exactly the job, the attestation, the agent and its hires, and pressing pay adds exactly one remainder-leg POST, never a usdc, deposit, redo, staged-decline or pull-request path', async () => {
      const requests: string[] = [];
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken }, (input, init) => {
        requests.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(input), baseUrl).pathname}`);
      });
      try {
        expect(requests).toEqual([
          'GET /jobs/job-fully-staged',
          'GET /jobs/job-fully-staged/attestation',
          'GET /agents/did%3Aabt%3Astaged-page-agent',
          'GET /agents/did%3Aabt%3Astaged-page-agent/hires',
        ]);

        const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
        payBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(requests.length).toBe(5);
        expect(requests[4]).toBe('POST /jobs/job-fully-staged/payments/remainder/abt/start');

        // Named negatives, verbatim from done-means: none of these five
        // paths is ever requested, on load or after the press.
        const wholeRecord = requests.join('\n').toLowerCase();
        expect(wholeRecord).not.toContain('usdc');
        expect(wholeRecord).not.toContain('/payments/deposit/');
        expect(wholeRecord).not.toMatch(/\/jobs\/[^/]+\/redo\b/);
        expect(wholeRecord).not.toContain('staged-decline');
        expect(wholeRecord).not.toContain('pull-request');
      } finally {
        page.close();
      }
    });
  });

  describe('every refusal in scope item 10 renders its own distinct sentence, so a future edit cannot collapse them (mutation proof: D1)', () => {
    it('the 401, 403, 409 and both 503 sentences from pay-start all differ from each other', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken });
      const originalFetch = global.fetch;
      async function mockedPayStart(cases: [number, string][]): Promise<string[]> {
        const btn = page.document.getElementById('pay-btn') as HTMLButtonElement;
        const out: string[] = [];
        for (const [status, error] of cases) {
          Object.defineProperty(page.window, 'fetch', {
            writable: true,
            value: async (input: string, init?: RequestInit) =>
              String(input).includes('/payments/remainder/abt/start')
                ? new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })
                : originalFetch(new URL(input, baseUrl), init),
          });
          btn.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          out.push(page.document.getElementById('pay-error-detail')?.textContent ?? '');
        }
        return out;
      }
      try {
        const sentences = await mockedPayStart([
          [401, ''],
          [403, ''],
          [409, 'internal: price_missing'],
          [503, 'the abt payment rail is not configured on this deployment'],
          [503, 'storage unavailable'],
        ]);
        expect(new Set(sentences).size).toBe(5);
        expect((sentences[0] ?? '').toLowerCase()).toContain('sign in');
        expect((sentences[1] ?? '').toLowerCase()).toContain('not a party');
        expect((sentences[2] ?? '').toLowerCase()).toContain('no agreed price');
        expect((sentences[3] ?? '').toLowerCase()).toContain('nothing was charged');
        expect((sentences[4] ?? '').toLowerCase()).not.toContain('nothing was charged');
      } finally {
        page.close();
      }
    });
  });

  describe('the ABT rail unconfigured (scope item 10)', () => {
    it('the 503 states nothing was charged, naming the rail', async () => {
      const buyerWallet = fromRandom();
      const buyerIdentity = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'staged-unconfigured-buyer', id: 9601 }) });
      const unconfiguredAccountRepo = new MemoryAccountRepository();
      await unconfiguredAccountRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'staged-unconfigured-buyer' });
      const unconfiguredAgentRepo = new MemoryAgentRepository();
      await unconfiguredAgentRepo.create({ did: AGENT_DID, operatorDid: OPERATOR_DID, delegation: delegationFixture(AGENT_DID, OPERATOR_DID), name: 'staged-unconfigured-scout', skills: ['triage'], githubLogin: null });
      const unconfiguredJobRepo = new MemoryJobRepository();
      const unconfiguredAttestationRepo = new MemoryAttestationRepository();
      const unconfiguredCredentialRepo = new MemoryCredentialRepository();
      const unconfiguredCredentials = createCredentialsAdapter(undefined, unconfiguredCredentialRepo);
      const unconfiguredJob = jobFixture({ id: 'job-unconfigured-abt', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-unconfigured' });
      await unconfiguredJobRepo.create(unconfiguredJob);
      const attestation = buildAttestation(unconfiguredJob, observationFixture({ diffHash: 'sha256:unconfigured' }), RECENT);
      const signed = await unconfiguredCredentials.signAttestation(attestation);
      await unconfiguredAttestationRepo.save({ jobId: unconfiguredJob.id, attestation, signed });

      const app = createApp(unconfiguredAccountRepo, unconfiguredAgentRepo, undefined, undefined, unconfiguredJobRepo, unconfiguredCredentials, undefined, unconfiguredCredentialRepo, undefined, undefined, undefined, buyerIdentity, undefined, unsettledGate(), undefined, unconfiguredAttestationRepo, null);
      const unconfiguredServer = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => unconfiguredServer.once('listening', resolve));
      const address = unconfiguredServer.address();
      if (address === null || typeof address === 'string') throw new Error('expected a port');
      const unconfiguredBaseUrl = `http://127.0.0.1:${address.port}`;
      try {
        const token = await mintSessionToken(buyerIdentity);
        const page = await renderStaged(unconfiguredBaseUrl, unconfiguredJob.id, { token });
        try {
          const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
          payBtn.click();
          await new Promise((resolve) => setTimeout(resolve, 200));
          const detail = page.document.getElementById('pay-error-detail')?.textContent ?? '';
          expect(detail.toLowerCase()).toContain('nothing was charged');
        } finally {
          page.close();
          void buyerWallet;
        }
      } finally {
        await new Promise<void>((resolve) => unconfiguredServer.close(() => resolve()));
      }
    });
  });

  describe('the job page routes a staged job to this screen (scope item 4)', () => {
    it("resolves the job page's own control to /staged?job=<id> (mutation proof: a missing href leaves the test red)", async () => {
      const page = await renderPage(baseUrl, '/jobs/job-fully-staged', null);
      try {
        const link = page.document.getElementById('staged-link') as HTMLAnchorElement | null;
        expect(link).not.toBeNull();
        expect(link!.getAttribute('href')).toBe('/staged?job=job-fully-staged');
      } finally {
        page.close();
      }
    });
  });

  describe('layout: no wrapper div breaks the facts or choices grid (layout-broken-at-desktop)', () => {
    it('the scan dialog close control is at least 44px, and every fact row and choice row is a direct child of its grid container with the grid declarations a wrapper div would break (D2)', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', { token: buyerToken });
      try {
        const closeBtn = page.document.querySelector('.sclose');
        expect(closeBtn).not.toBeNull();
        const closeStyle = page.window.getComputedStyle(closeBtn as Element);
        expect(parseFloat(closeStyle.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(closeStyle.height)).toBeGreaterThanOrEqual(44);

        const factsGrid = page.document.getElementById('facts');
        const factRows = Array.from(page.document.querySelectorAll('#facts > li'));
        expect(factRows.length).toBe(6);
        factRows.forEach((row) => {
          expect(row.parentElement).toBe(factsGrid);
          const style = page.window.getComputedStyle(row as Element);
          expect(style.display).toBe('grid');
          expect(style.gridTemplateColumns).toBe('1fr auto');
        });

        const pathsList = page.document.querySelector('#facts .paths');
        expect(pathsList).not.toBeNull();
        const pathsStyle = page.window.getComputedStyle(pathsList as Element);
        expect(pathsStyle.gridColumn).toBe('1 / -1');

        const choicesGrid = page.document.getElementById('choices');
        const choiceRows = Array.from(page.document.querySelectorAll('#choices > li'));
        expect(choiceRows.length).toBe(3);
        choiceRows.forEach((row) => {
          expect(row.parentElement).toBe(choicesGrid);
          const style = page.window.getComputedStyle(row as Element);
          expect(style.display).toBe('grid');
          expect(style.gridTemplateColumns).toBe('1fr auto');
        });

        const paraCell = page.document.querySelector('#choices .para');
        expect(paraCell).not.toBeNull();
        const paraStyle = page.window.getComputedStyle(paraCell as Element);
        expect(paraStyle.gridColumn).toBe('1 / -1');
      } finally {
        page.close();
      }
    });
  });
});
