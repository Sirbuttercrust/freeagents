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
import { ABT_FEE_RATE_PERCENT, calculateFee, remainderUsd, depositUsd } from '../../src/domain/payment.js';
import { didSuffix } from '../../src/domain/agent.js';
import { createAbtPaymentRail } from '../../src/adapters/payment/abt.js';
import { fromRandom } from '@ocap/wallet';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession, mintSessionToken } from '../helpers/session-fixtures.js';
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
  session: { token: string; subject?: string; method?: string } | null,
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
  session: { token: string; subject?: string; method?: string } | null,
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
  // P8k round 1 fix (qa D1): the buyer's session subject/method, needed
  // by every test that exercises redo or decline (staged.js's own party
  // probe reads these, not just the token).
  let buyerSession: { readonly token: string; readonly subject: string; readonly method: 'github-oauth' | 'passkey' };

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
    // The agent's own account (P8k: an agent signed in on a staged hire
    // must be refused with the buyer-only 403, done-means item 13),
    // registered with its own GitHub login so a session can be minted
    // for it distinct from the buyer's.
    await accountRepo.register({ did: AGENT_DID, githubLogin: 'staged-page-agent-login' });

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

    // P8k: the DEPOSIT half-up tie case (distinct from the remainder tie
    // above): priceUsd 0.50 at depositPercent 3 makes the deposit itself
    // exactly 0.0150, the same tie calculateFee('0.50', 3) = '0.02' pins
    // in tests/domain/payment.test.ts. The decline dialog's deposit
    // figure must match that, not truncate to 0.01.
    const depositTieCase = jobFixture({ id: 'job-deposit-tie-case', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '0.50', rail: 'abt', depositPercent: 3, redoAllowance: 1, priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-deposit-tie-case' });
    await jobRepo.create(depositTieCase);
    await storeAttestation(depositTieCase, observationFixture({ diffHash: 'sha256:deposit-tie-case' }), credentials);

    // Not staged: a job at confirmed, for the not-ready panel.
    await jobRepo.create(jobFixture({ id: 'job-confirmed-not-staged', status: 'confirmed', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true }));

    // redo_requested: the account of the work must still render (ruling
    // 5), so this fixture carries a stored attestation like every other
    // staged/redo_requested job below.
    const redoRequestedJob = jobFixture({ id: 'job-redo-requested', status: 'redo_requested', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-redo-requested', redoRequestedCriterionIndex: 0, redoRequestedAt: RECENT });
    await jobRepo.create(redoRequestedJob);
    await storeAttestation(redoRequestedJob, observationFixture({ diffHash: 'sha256:redo-requested' }), credentials);

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
    // parsed (api.js rule 3). The criterion text also carries markup
    // (round 1 fix, qa D3), for the picker's own escaping guard: the
    // only fixture in this file that puts markup in a criterion.
    const markupJob = jobFixture({ id: 'job-markup', status: 'staged', criteria: [{ text: '<img src=x onerror=alert(1)>Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '150.00', rail: 'abt', redoAllowance: 1, priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-markup' });
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

    // P8k: three confirmed criteria, for the picker's numbering test
    // (ruling 2: numbered the same way agreement.js numbers them, from 1
    // in stored order).
    const multiCriteria = jobFixture({
      id: 'job-multi-criteria',
      status: 'staged',
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
        { text: 'Every existing test still passes', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
        { text: 'A regression test covers the bug', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      ],
      priceUsd: '900.00',
      rail: 'abt',
      depositPercent: 25,
      redoAllowance: 1,
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      stagedAt: RECENT,
      stagedCommit: 'commit-multi-criteria',
    });
    await jobRepo.create(multiCriteria);
    await storeAttestation(multiCriteria, observationFixture({ diffHash: 'sha256:multi-criteria' }), credentials);

    // P8k: the redo allowance already spent (usedCount === redoAllowance).
    // No redo button renders in any form (done means: absence, not a
    // disabled attribute).
    const redoExhausted = jobFixture({
      id: 'job-redo-exhausted',
      status: 'staged',
      criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      priceUsd: '400.00',
      rail: 'abt',
      redoAllowance: 1,
      redoUsedCount: 1,
      redoRequestedCriterionIndex: 0,
      redoRequestedAt: new Date(RECENT.getTime() - 1000),
      redoRefusedAt: RECENT,
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      stagedAt: RECENT,
      stagedCommit: 'commit-redo-exhausted',
    });
    await jobRepo.create(redoExhausted);
    await storeAttestation(redoExhausted, observationFixture({ diffHash: 'sha256:redo-exhausted' }), credentials);

    // P8k: a fresh job per mutating test (redo / decline actually POST
    // and move the job), so one test's write cannot leak into another's
    // fixture. Each is staged, one confirmed criterion, redoAllowance 1.
    function freshStagedJob(id: string, priceUsd: string): Job {
      return jobFixture({
        id,
        status: 'staged',
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd,
        rail: 'abt',
        depositPercent: 25,
        redoAllowance: 1,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        stagedAt: RECENT,
        stagedCommit: `commit-${id}`,
      });
    }
    for (const id of ['job-redo-flow', 'job-redo-malformed-guard', 'job-redo-reenable-guard', 'job-decline-flow', 'job-decline-reenable-guard', 'job-decline-conflict', 'job-agent-view', 'job-signed-out-view']) {
      const fixture = freshStagedJob(id, '900.00');
      await jobRepo.create(fixture);
      await storeAttestation(fixture, observationFixture({ diffHash: `sha256:${id}` }), credentials);
    }

    const sessionAdapterRef = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'staged-page-buyer', id: 9401 }) });

    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, credentials, undefined, credentialRepo, undefined, undefined, undefined, sessionAdapterRef, undefined, unsettledGate(), undefined, attestationRepo);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    buyerSession = await mintSession(sessionAdapterRef);
    buyerToken = buyerSession.token;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('a signed-out visitor, an unknown job id, and a staged job with no attestation on record', () => {
    it('each renders its own readable panel, never a blank screen', async () => {
      const signedOut = await renderStaged(baseUrl, 'job-fully-staged', null);
      const unknownJob = await renderStaged(baseUrl, 'no-such-job', buyerSession);
      const noAttestation = await renderStaged(baseUrl, 'job-no-attestation', buyerSession);
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
      const page = await renderStaged(baseUrl, 'job-confirmed-not-staged', buyerSession);
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

  });

  // P8k ruling 5: redo_requested now renders on THIS page (the clock and
  // the account of the work, no control), not the not-ready panel. This
  // supersedes the P8j test above, which pinned the old bounce-to-dead-
  // panel behaviour before this card gave the buyer a real redo control
  // to reach that status from. Edited per the brief's own instruction
  // (a test edited to accommodate new, in-scope behaviour), named here
  // in the handoff.
  describe('redo_requested renders on this page, not the not-ready panel (ruling 5, mutation proof 13)', () => {
    it('shows the clock and the account of the work, one sentence naming the operator has not answered, and no acting control', async () => {
      const page = await renderStaged(baseUrl, 'job-redo-requested', buyerSession);
      try {
        expect(page.document.getElementById('not-ready-error')?.hidden).toBe(true);
        expect(page.document.getElementById('staged-body')?.hidden).toBe(false);
        const note = page.document.getElementById('redo-pending-note')?.textContent ?? '';
        expect(note.toLowerCase()).toContain('redo');
        expect(note).toBe('The buyer has asked for a redo on the staged work. The operator has not yet answered.');
        expect(page.document.getElementById('choices-section')?.hidden).toBe(true);
        expect(page.document.getElementById('clock-days')?.textContent).not.toBe('');
      } finally {
        page.close();
      }
    });
  });

  describe('the account of the work: six facts, same weight, fixed order, ruling 2 omitted', () => {
    it('renders exactly six fact rows in the fixed order, with the full path list untruncated, one shared class vocabulary, and no test-vocabulary anywhere (mutation proofs 5, 6)', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
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
      const page = await renderStaged(baseUrl, 'job-markup', buyerSession);
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

    // Round 1 fix (qa D3): a criterion's text is buyer/agent prose from
    // a hire this platform does not author, the same class of untrusted
    // string the facts list already guards. No fixture in this file put
    // markup INSIDE a criterion before this test; job-markup's own
    // criterion now does (its jobFixture above), so this exercises the
    // picker row specifically, not the facts list.
    it("a criterion's text containing markup renders as literal text in the redo picker (api.js rule 3)", async () => {
      const page = await renderStaged(baseUrl, 'job-markup', buyerSession);
      try {
        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        const picker = page.document.getElementById('redo-picker');
        expect(picker?.querySelector('img')).toBeNull();
        expect(picker?.querySelector('script')).toBeNull();
        const text = picker?.textContent ?? '';
        expect(text).toContain('<img src=x onerror=alert(1)>Done');
      } finally {
        page.close();
      }
    });
  });

  describe('the clock (ruling 4, mutation proofs 1 and 2)', () => {
    it('states the deadline as stagedAt plus LAPSE_AT_STAGED_AFTER_DAYS for a job never redone, with no draining bar or countdown element', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
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
      const page = await renderStaged(baseUrl, 'job-redone-once', buyerSession);
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

  // P8k: this test's own title and its "pay button is the only acting
  // control" assertion described the P8j-shipped screen, which rendered
  // redo and decline as inert prose (P8j ruling 1, split for the source-
  // line cap). This card gives both their buttons, so the choices list
  // still carries no button (unchanged: it is prose with real amounts,
  // not a second copy of the acts), but the acts row is now three
  // buttons wide, pay primary, exactly as the done-means section
  // requires. Edited per the brief's own instruction (a test edited to
  // accommodate new, in-scope markup), named here in the handoff.
  describe('the three choices, computed from the projection and pinned against src/domain/payment.ts', () => {
    it('the pay amount, fee and total agree with remainderUsd/calculateFee, the choices list stays prose with no button, and the acts row is exactly three controls, pay first and primary (mutation proofs 3, 4, 13)', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
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

        // Done means: exactly three acting controls, pay first and
        // primary, neither new control primary.
        const acts = page.document.getElementById('acts');
        const actButtons = Array.from(acts?.querySelectorAll('button') ?? []);
        expect(actButtons.map((b) => b.id)).toEqual(['pay-btn', 'redo-btn', 'decline-btn']);
        expect(actButtons[0]?.classList.contains('btn-primary')).toBe(true);
        expect(actButtons[1]?.classList.contains('btn-primary')).toBe(false);
        expect(actButtons[2]?.classList.contains('btn-primary')).toBe(false);

        // No other button anywhere on the page issues a request: every
        // remaining button is the disclose control or a copy control.
        const main = page.document.querySelector('main');
        const otherButtons = Array.from(main?.querySelectorAll('button') ?? []).filter((b) => !['pay-btn', 'redo-btn', 'decline-btn'].includes(b.id));
        otherButtons.forEach((b) => {
          expect(b.classList.contains('disclose') || b.hasAttribute('data-copy')).toBe(true);
        });
      } finally {
        page.close();
      }
    });

    it('the half-up tie case (a $0.50 remainder at 3 percent) matches payment.ts exactly (mutation proof 4)', async () => {
      const page = await renderStaged(baseUrl, 'job-tie-case', buyerSession);
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
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
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
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
      try {
        expect(page.document.getElementById('agent-name')?.textContent).toBe('staged-page-scout');
        expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('');
      } finally {
        page.close();
      }
    });

    it('renders the real count from GET /agents/:agentDid/hires when the agent has a verified hire', async () => {
      const page = await renderStaged(baseUrl, 'job-hired-agent-has-hires', buyerSession);
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
        const page = await renderStaged(proxyBaseUrl, 'job-hired-agent-has-hires', buyerSession);
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
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
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
      const page = await renderStaged(baseUrl, 'job-with-pr', buyerSession, (input) => {
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
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession, (input, init) => {
        requests.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(input), baseUrl).pathname}`);
      });
      try {
        // Round 1 fix (qa D1): staged.js now also fires GET
        // /accounts/:did (the party probe) before rendering the acting
        // controls. It fires from a separate promise chain than the
        // agent/hires calls renderWho makes, so its position in the
        // load burst is not fixed relative to those two; asserted as a
        // set, not an order, for that one reason. The job and
        // attestation reads keep their fixed first-two position since
        // they gate everything else on the page.
        expect(requests.slice(0, 2)).toEqual(['GET /jobs/job-fully-staged', 'GET /jobs/job-fully-staged/attestation']);
        expect(new Set(requests.slice(2))).toEqual(new Set([
          'GET /agents/did%3Aabt%3Astaged-page-agent',
          'GET /agents/did%3Aabt%3Astaged-page-agent/hires',
          'GET /accounts/did%3Aabt%3Astaged-page-buyer-account',
        ]));
        expect(requests.length).toBe(5);

        const payBtn = page.document.getElementById('pay-btn') as HTMLButtonElement;
        payBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(requests.length).toBe(6);
        expect(requests[5]).toBe('POST /jobs/job-fully-staged/payments/remainder/abt/start');

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
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
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

  describe('the three acting controls: pay, redo, decline (done means: exactly three, pay first and primary)', () => {
    it('renders three controls in the wireframe order and no other element on the page issues a request besides them, the disclose control and copy controls', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
      try {
        const acts = page.document.getElementById('acts');
        const buttons = Array.from(acts?.querySelectorAll('button') ?? []);
        expect(buttons.map((b) => b.id)).toEqual(['pay-btn', 'redo-btn', 'decline-btn']);
        expect(buttons[0]?.textContent).toContain('Pay the balance');
        expect(buttons[1]?.textContent).toBe('Send it back once, free');
        expect(buttons[2]?.textContent).toBe('Decline the work');
        expect(buttons[0]?.classList.contains('btn-primary')).toBe(true);
        expect(buttons[1]?.classList.contains('btn-primary')).toBe(false);
        expect(buttons[2]?.classList.contains('btn-primary')).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('the redo picker (ruling 2): rows are job.criteria, numbered like agreement.js, nothing preselected', () => {
    it('renders one row per confirmed criterion in stored order, numbered from 1 the same way the agreement screen numbers the same lines, with no radio preselected and send disabled until one is chosen', async () => {
      const agreementPage = await renderPage(baseUrl, '/agreement?job=job-multi-criteria', null);
      const stagedPage = await renderStaged(baseUrl, 'job-multi-criteria', buyerSession);
      try {
        // The agreement screen's own rendered numbering for the three
        // criteria (its first three rows; price/delivery are appended
        // after, per agreement.js's own header comment).
        const agreementNums = Array.from(agreementPage.document.querySelectorAll('#terms .trow .num')).slice(0, 3).map((n) => n.textContent);

        const redoBtn = stagedPage.document.getElementById('redo-btn') as HTMLButtonElement;
        expect(redoBtn).not.toBeNull();
        redoBtn.click();
        const picker = stagedPage.document.getElementById('redo-picker');
        const rows = Array.from(picker?.querySelectorAll('li') ?? []);
        expect(rows.length).toBe(3);

        const radios = Array.from(picker?.querySelectorAll('input[type="radio"]') ?? []) as HTMLInputElement[];
        expect(radios.length).toBe(3);
        radios.forEach((r) => expect(r.checked).toBe(false));

        const labelsText = rows.map((r) => r.textContent ?? '');
        agreementNums.forEach((num, i) => {
          expect(labelsText[i]).toContain(String(num));
        });
        expect(labelsText[0]).toContain('The login bug is fixed');
        expect(labelsText[1]).toContain('Every existing test still passes');
        expect(labelsText[2]).toContain('A regression test covers the bug');

        // The array index posted is 0-based regardless of the label
        // (mutation proof 3): the value attribute IS the array index.
        expect(radios.map((r) => r.value)).toEqual(['0', '1', '2']);

        const sendBtn = stagedPage.document.getElementById('redo-send-btn') as HTMLButtonElement;
        expect(sendBtn.disabled).toBe(true);
      } finally {
        agreementPage.close();
        stagedPage.close();
      }
    });

    it('no text input, textarea or contenteditable element exists anywhere in the redo dialog (ruling 1, mutation proof 5)', async () => {
      const page = await renderStaged(baseUrl, 'job-multi-criteria', buyerSession);
      try {
        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        const dialog = page.document.getElementById('redo');
        expect(dialog?.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable]').length).toBe(0);
      } finally {
        page.close();
      }
    });

    it('the extension named in the redo dialog equals REDO_LAPSE_EXTENSION_DAYS, read from the domain, never typed as a literal (ruling 4, mutation proof 7)', async () => {
      const page = await renderStaged(baseUrl, 'job-multi-criteria', buyerSession);
      try {
        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        const note = page.document.getElementById('redo-cost-note')?.textContent ?? '';
        expect(note).toContain(String(REDO_LAPSE_EXTENSION_DAYS) + ' days');
      } finally {
        page.close();
      }
    });

    it('selecting a line enables send, and it stays disabled until then (guard-without-a-test)', async () => {
      const requests: string[] = [];
      const page = await renderStaged(baseUrl, 'job-multi-criteria', buyerSession, (input, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') requests.push(new URL(String(input), baseUrl).pathname);
      });
      try {
        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        const radios = Array.from(page.document.querySelectorAll('#redo-picker input[type="radio"]')) as HTMLInputElement[];
        const sendBtn = page.document.getElementById('redo-send-btn') as HTMLButtonElement;
        expect(sendBtn.disabled).toBe(true);
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(requests.length).toBe(0);
        radios[1]!.checked = true;
        radios[1]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        expect(sendBtn.disabled).toBe(false);
      } finally {
        page.close();
      }
    });
  });

  describe('the redo control is absent, never disabled, once the allowance is spent (ruling 6, mutation proof 6)', () => {
    it('no redo button exists in the document in any state, and the choices list says the redo is spent', async () => {
      const page = await renderStaged(baseUrl, 'job-redo-exhausted', buyerSession);
      try {
        expect(page.document.getElementById('redo-btn')).toBeNull();
        const acts = page.document.getElementById('acts');
        expect(Array.from(acts?.querySelectorAll('button') ?? []).map((b) => b.id)).toEqual(['pay-btn', 'decline-btn']);
        const choices = page.document.querySelectorAll('#choices > li');
        const redoRow = choices[1];
        expect(redoRow?.querySelector('.v')?.textContent).toBe('spent');
      } finally {
        page.close();
      }
    });
  });

  describe('the decline dialog (ruling 3): four consequence rows, the operator-record claim never appears', () => {
    it('renders exactly four rows and the deposit figure equals depositUsd(priceUsd, depositPercent) for this job, and the wireframe fifth row never appears in any wording', async () => {
      const page = await renderStaged(baseUrl, 'job-multi-criteria', buyerSession);
      try {
        (page.document.getElementById('decline-btn') as HTMLButtonElement).click();
        const rows = page.document.querySelectorAll('#decline-consequences > li');
        expect(rows.length).toBe(4);
        const expectedDeposit = depositUsd('900.00', 25);
        const depositRow = rows[1];
        expect(depositRow?.querySelector('.v')?.textContent).toContain(`$${expectedDeposit}`);

        const dialogText = (page.document.getElementById('decline')?.textContent ?? '').toLowerCase();
        expect(dialogText).not.toContain("axiom-ui's record");
        expect(dialogText).not.toContain('agent\u2019s record');
        expect(dialogText).not.toContain("agent's record");
        expect(dialogText).not.toMatch(/operator'?s?\s+record\s+gains/);
      } finally {
        page.close();
      }
    });

    it('the deposit half-up tie case matches payment.ts exactly (mutation proof 9)', async () => {
      const page = await renderStaged(baseUrl, 'job-deposit-tie-case', buyerSession);
      try {
        (page.document.getElementById('decline-btn') as HTMLButtonElement).click();
        const rows = page.document.querySelectorAll('#decline-consequences > li');
        const depositRow = rows[1];
        const expectedDeposit = depositUsd('0.50', 3);
        expect(expectedDeposit).toBe('0.02');
        expect(depositRow?.querySelector('.v')?.textContent).toContain(`$${expectedDeposit}`);
      } finally {
        page.close();
      }
    });
  });

  describe('pressing redo (rulings 1, 2, 6): posts exactly once, criterionIndex only, and re-renders redo_requested', () => {
    it('posts { criterionIndex } with no other key, exactly once, disables on press, two synchronous clicks fire no second request, and the re-read shows redo_requested with no control', async () => {
      const requests: { method: string; path: string; body: unknown }[] = [];
      const page = await renderStaged(baseUrl, 'job-redo-flow', buyerSession, (input, init) => {
        requests.push({
          method: (init?.method ?? 'GET').toUpperCase(),
          path: new URL(String(input), baseUrl).pathname,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
      });
      try {
        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        const radios = Array.from(page.document.querySelectorAll('#redo-picker input[type="radio"]')) as HTMLInputElement[];
        radios[0]!.checked = true;
        radios[0]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        const sendBtn = page.document.getElementById('redo-send-btn') as HTMLButtonElement;
        sendBtn.click();
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const redoPosts = requests.filter((r) => r.method === 'POST' && /\/redo$/.test(r.path));
        expect(redoPosts.length).toBe(1);
        expect(Object.keys(redoPosts[0]!.body as object)).toEqual(['criterionIndex']);
        expect((redoPosts[0]!.body as { criterionIndex: number }).criterionIndex).toBe(0);

        expect(page.document.getElementById('choices-section')?.hidden).toBe(true);
        const note = page.document.getElementById('redo-pending-note')?.textContent ?? '';
        expect(note.toLowerCase()).toContain('redo');

        const after = await fetch(`${baseUrl}/jobs/job-redo-flow`, { headers: { Accept: 'application/json' } });
        const afterBody = (await after.json()) as { status: string };
        expect(afterBody.status).toBe('redo_requested');
      } finally {
        page.close();
      }
    });

    it('does not re-enable the send control after a successful press, so a second click after the response resolves fires no second request (mutation proof 12)', async () => {
      const requests: { method: string; path: string }[] = [];
      const page = await renderStaged(baseUrl, 'job-redo-reenable-guard', buyerSession, (input, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') requests.push({ method: 'POST', path: new URL(String(input), baseUrl).pathname });
      });
      try {
        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        const radios = Array.from(page.document.querySelectorAll('#redo-picker input[type="radio"]')) as HTMLInputElement[];
        radios[0]!.checked = true;
        radios[0]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        const sendBtn = page.document.getElementById('redo-send-btn') as HTMLButtonElement;
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(requests.filter((r) => /\/redo$/.test(r.path)).length).toBe(1);
        // The dialog closes on success but the button element still lives
        // in the DOM (a dialog close, not a removal). If the control were
        // re-enabled after success this second click would fire a real
        // second request; it must not.
        expect(sendBtn.disabled).toBe(true);
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(requests.filter((r) => /\/redo$/.test(r.path)).length).toBe(1);
      } finally {
        page.close();
      }
    });

    it('a malformed body (400) shows a fault-in-this-screen sentence, never blaming the buyer (scope item 4)', async () => {
      const page = await renderStaged(baseUrl, 'job-redo-malformed-guard', buyerSession);
      const originalFetch = global.fetch;
      try {
        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        const radios = Array.from(page.document.querySelectorAll('#redo-picker input[type="radio"]')) as HTMLInputElement[];
        radios[0]!.checked = true;
        radios[0]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        Object.defineProperty(page.window, 'fetch', {
          writable: true,
          value: async (input: string, init?: RequestInit) =>
            String(input).includes('/redo')
              ? new Response(JSON.stringify({ error: 'body must be { criterionIndex: number }' }), { status: 400, headers: { 'content-type': 'application/json' } })
              : originalFetch(new URL(input, baseUrl), init),
        });
        (page.document.getElementById('redo-send-btn') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const detail = page.document.getElementById('redo-error-detail')?.textContent ?? '';
        expect(detail.toLowerCase()).not.toContain('you');
        expect(detail.toLowerCase()).toContain('screen');
      } finally {
        page.close();
      }
    });
  });

  describe('pressing decline (ruling 6): body-less, exactly once, terminal panel with a link back', () => {
    it('posts with no body, exactly once, disables on press, a second click fires no second request, and the re-read shows the terminal panel with a link to /jobs/<id>', async () => {
      const requests: { method: string; path: string; body: string | null }[] = [];
      const page = await renderStaged(baseUrl, 'job-decline-flow', buyerSession, (input, init) => {
        requests.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(String(input), baseUrl).pathname, body: typeof init?.body === 'string' ? init.body : null });
      });
      try {
        (page.document.getElementById('decline-btn') as HTMLButtonElement).click();
        const sendBtn = page.document.getElementById('decline-send-btn') as HTMLButtonElement;
        sendBtn.click();
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const declinePosts = requests.filter((r) => r.method === 'POST' && /staged-decline$/.test(r.path));
        expect(declinePosts.length).toBe(1);
        expect(declinePosts[0]!.body).toBeNull();

        const after = await fetch(`${baseUrl}/jobs/job-decline-flow`, { headers: { Accept: 'application/json' } });
        const afterBody = (await after.json()) as { status: string };
        expect(afterBody.status).toBe('staged_declined');
      } finally {
        page.close();
      }
    });

    // Round 1 fix (qa D2): mirrors the redo path's own re-enable guard
    // test above. The existing "no body... second click fires no second
    // request" test above fires its two clicks synchronously, which the
    // in-flight disable already stops on its own; it cannot observe
    // whether the control re-enables once the response resolves. This
    // test waits for the first request to complete before clicking
    // again, the only way to exercise the never-re-enable-on-success
    // rule specifically.
    it('does not re-enable the send control after a successful press, so a second click after the response resolves fires no second request', async () => {
      const requests: { method: string; path: string }[] = [];
      const page = await renderStaged(baseUrl, 'job-decline-reenable-guard', buyerSession, (input, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') requests.push({ method: 'POST', path: new URL(String(input), baseUrl).pathname });
      });
      try {
        (page.document.getElementById('decline-btn') as HTMLButtonElement).click();
        const sendBtn = page.document.getElementById('decline-send-btn') as HTMLButtonElement;
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(requests.filter((r) => /staged-decline$/.test(r.path)).length).toBe(1);
        // The dialog closes on success but the button element still
        // lives in the DOM (a dialog close, not a removal). If the
        // control were re-enabled after success this second click would
        // fire a real second request; it must not.
        expect(sendBtn.disabled).toBe(true);
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(requests.filter((r) => /staged-decline$/.test(r.path)).length).toBe(1);
      } finally {
        page.close();
      }
    });

    it('a re-read of the declined job renders the terminal panel with a link back and no control', async () => {
      const page = await renderStaged(baseUrl, 'job-decline-conflict', buyerSession);
      try {
        (page.document.getElementById('decline-btn') as HTMLButtonElement).click();
        (page.document.getElementById('decline-send-btn') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        page.close();

        const secondView = await renderStaged(baseUrl, 'job-decline-conflict', buyerSession);
        try {
          const panel = secondView.document.getElementById('declined-panel');
          expect(panel?.hidden).toBe(false);
          expect(secondView.document.getElementById('staged-body')?.hidden).toBe(true);
          const link = secondView.document.getElementById('declined-link') as HTMLAnchorElement | null;
          expect(link?.getAttribute('href')).toBe('/jobs/job-decline-conflict');
        } finally {
          secondView.close();
        }
      } finally {
        // page already closed above
      }
    });
  });

  describe('party and session gates on redo and decline (done means item 13, 14)', () => {
    // Round 1 fix (qa D1): GET /jobs/:jobId/attestation (the party probe
    // every page on this screen shares, staged.js's own header comment)
    // admits BOTH the buyer and the agent on a job (app.ts:3485,
    // resolveJobActingParty), so a signed-in agent still reads this
    // screen. What changed is the acting controls: staged.js now also
    // resolves whether the session's account IS the job's buyerDid (via
    // GET /accounts/:did, already mounted, unauthenticated) before
    // rendering redo or decline, so an agent who is not that buyer sees
    // neither control, closing the gap qa's round 1 review found.
    it('an agent signed in on a staged hire is refused with the buyer-only 403 sentence and is shown neither control, and the job is unchanged', async () => {
      const agentSessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'staged-page-agent-login', id: 9403 }) });
      const agentAccountRepo = new MemoryAccountRepository();
      await agentAccountRepo.register({ did: AGENT_DID, githubLogin: 'staged-page-agent-login' });
      await agentAccountRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'staged-page-buyer' });
      const agentServer = createApp(agentAccountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, agentSessionAdapter, undefined, unsettledGate(), undefined, attestationRepo).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => agentServer.once('listening', resolve));
      const agentBaseUrl = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}`;
      try {
        const agentToken = await mintSessionToken(agentSessionAdapter);
        const page = await renderStaged(agentBaseUrl, 'job-agent-view', { token: agentToken });
        try {
          expect(page.document.getElementById('party-error')?.hidden).toBe(true);
          expect(page.document.getElementById('staged-body')?.hidden).toBe(false);
          expect(page.document.getElementById('redo-btn')).toBeNull();
          expect(page.document.getElementById('decline-btn')).toBeNull();
          // Pay is out of this card's scope and stays visible for both
          // parties (the not-a-buyer party-probe fix is redo/decline
          // only); the server's own buyer-only gate on pay start is
          // P8j's, unchanged here.

          // The server-side buyer-only gate still stands on its own,
          // independent of the UI: a direct POST with the agent's token
          // is refused with the exact 403 sentence (mutation proof 14).
          const declineRes = await fetch(`${agentBaseUrl}/jobs/job-agent-view/staged-decline`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${agentToken}` },
          });
          expect(declineRes.status).toBe(403);
          const declineBody = (await declineRes.json()) as { error: string };
          expect(declineBody.error).toBe('only the buyer may staged-decline this job');

          const after = await fetch(`${agentBaseUrl}/jobs/job-agent-view`, { headers: { Accept: 'application/json' } });
          const afterBody = (await after.json()) as { status: string };
          expect(afterBody.status).toBe('staged');
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => agentServer.close(() => resolve()));
      }
    });

    it('a signed-out visitor is sent to sign in and the acting controls are never reached (staged-body stays hidden)', async () => {
      const page = await renderStaged(baseUrl, 'job-signed-out-view', null);
      try {
        expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
        expect(page.document.getElementById('staged-body')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });

  describe('the session token appears nowhere in the document, including inside the redo and decline dialogs', () => {
    it('opening both dialogs still leaves the token absent from the whole rendered document', async () => {
      const page = await renderStaged(baseUrl, 'job-multi-criteria', buyerSession);
      try {
        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        (page.document.getElementById('decline-btn') as HTMLButtonElement).click();
        expect(page.document.documentElement.outerHTML).not.toContain(buyerToken);
      } finally {
        page.close();
      }
    });
  });

  describe('layout: 320px minimum, 44px tap targets, no fixed width on the new controls (layout-broken-at-desktop)', () => {
    it('both new dialogs cap at min(520px, 100vw - 24px) with no fixed width, every picker row and both send/decline/close controls are at least 44px, and the acts row wraps rather than overflowing', async () => {
      const page = await renderStaged(baseUrl, 'job-multi-criteria', buyerSession);
      try {
        const css = page.document.querySelector('style')?.textContent ?? '';

        // The dialog shell is shared furniture from P8j (ruling: take
        // dialog classes from what P8j shipped); both new dialogs use
        // the same .sheet rule, so this pins that neither one overrides
        // it with a fixed width.
        expect(css).toMatch(/\.sheet\s*\{[^}]*width:\s*min\(520px,\s*calc\(100vw - 24px\)\)/);

        (page.document.getElementById('redo-btn') as HTMLButtonElement).click();
        const redoClose = page.document.querySelector('#redo .sclose');
        expect(redoClose).not.toBeNull();
        const redoCloseStyle = page.window.getComputedStyle(redoClose as Element);
        expect(parseFloat(redoCloseStyle.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(redoCloseStyle.height)).toBeGreaterThanOrEqual(44);

        // jsdom's getComputedStyle does not always resolve cross-rule
        // cascade order the way a real engine does (a known limitation),
        // so the send buttons' 44px floor is pinned by reading the
        // declared rule text, the same technique the existing facts/
        // choices layout test below already uses for the paths rule.
        expect(css).toMatch(/#redo-send-btn\s*\{[^}]*min-height:\s*44px/);
        expect(css).toMatch(/#decline-send-btn\s*\{[^}]*min-height:\s*44px/);

        const pickerLabels = Array.from(page.document.querySelectorAll('#redo-picker label'));
        expect(pickerLabels.length).toBe(3);
        pickerLabels.forEach((label) => {
          const style = page.window.getComputedStyle(label as Element);
          expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
        });
        // The picker rule itself, read from the stylesheet (jsdom has no
        // real layout engine, so the wrap behaviour is pinned as a
        // declared rule the way the existing facts/choices layout test
        // already does, not as a measured reflow).
        const pickerRule = css.match(/\.picker label\s*\{[^}]*\}/)?.[0] ?? '';
        expect(pickerRule).toMatch(/grid-template-columns:\s*22px 1fr/);
        expect(pickerRule).toMatch(/min-height:\s*44px/);

        (page.document.getElementById('decline-btn') as HTMLButtonElement).click();
        const declineClose = page.document.querySelector('#decline .sclose');
        const declineCloseStyle = page.window.getComputedStyle(declineClose as Element);
        expect(parseFloat(declineCloseStyle.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(declineCloseStyle.height)).toBeGreaterThanOrEqual(44);

        // The acts row wraps (flex-wrap) rather than declaring a fixed
        // width that would overflow at 320px.
        const actsRule = css.match(/\.acts\s*\{[^}]*\}/)?.[0] ?? '';
        expect(actsRule).toMatch(/flex-wrap:\s*wrap/);
        expect(actsRule).not.toMatch(/[^-]width:\s*\d/);
      } finally {
        page.close();
      }
    });

    it('at a 1280px viewport the acts row measures as the wireframe layout: three buttons, pay first and primary, in one flex row', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
      try {
        Object.defineProperty(page.window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
        const acts = page.document.getElementById('acts');
        const style = page.window.getComputedStyle(acts as Element);
        expect(style.display).toBe('flex');
        const buttons = Array.from(acts?.children ?? []);
        expect(buttons.length).toBe(3);
        expect((buttons[0] as HTMLElement).id).toBe('pay-btn');
      } finally {
        page.close();
      }
    });
  });

  describe('layout: no wrapper div breaks the facts or choices grid (layout-broken-at-desktop)', () => {
    it('the scan dialog close control is at least 44px, and every fact row and choice row is a direct child of its grid container with the grid declarations a wrapper div would break (D2)', async () => {
      const page = await renderStaged(baseUrl, 'job-fully-staged', buyerSession);
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
        expect(factsGrid?.tagName).toBe('UL');
        expect(choicesGrid?.tagName).toBe('UL');
        const css = page.document.querySelector('style')?.textContent ?? '';
        const pathsRule = css.match(/\.facts \.paths\s*\{[^}]*\}/)?.[0] ?? '';
        expect(pathsRule).toMatch(/overflow-wrap:\s*anywhere/);
        expect(pathsRule).not.toMatch(/[^-]width:\s*\d/);
        expect(css).toContain('@media (max-width: 520px) { .facts li { grid-template-columns: 1fr; }');
      } finally {
        page.close();
      }
    });
  });
});
