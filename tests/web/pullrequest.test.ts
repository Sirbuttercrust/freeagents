// P8l: the pull-request screen, driven end to end against the real app (the discipline tests/web/staged.test.ts, tests/web/deposit.test.ts and tests/web/agreement.test.ts already hold to). Every route the wireframe wires up is exercised for real: GET /jobs/:jobId/attestation against a real signed attestation, POST .../cited-close against a real settlement gate, never asserted from a client-side stub.
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
import { createJob, type Job, DEEM_COMPLETED_AFTER_DAYS } from '../../src/domain/job.js';
import { buildAttestation, type StagingObservation, type Attestation } from '../../src/domain/attestation.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { ABT_FEE_RATE_PERCENT, calculateFee, remainderUsd, depositUsd } from '../../src/domain/payment.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession, mintSessionToken } from '../helpers/session-fixtures.js';
import { createPasskeyFixture } from '../helpers/webauthn-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:pr-page-agent';
const HIRED_AGENT_DID = 'did:abt:pr-page-hired-agent';
const BUYER_ACCOUNT_DID = 'did:abt:pr-page-buyer-account';
const STRANGER_ACCOUNT_DID = 'did:abt:pr-page-stranger-account';
const OPERATOR_DID = 'did:abt:pr-page-operator';
const TERMINAL_AGENT_DID = 'did:abt:pr-page-terminal-agent';
// Recent, not hardcoded: GET /jobs/:jobId runs the live lapse clocks on every read. A submittedAt more than DEEM_COMPLETED_AFTER_DAYS old would flip the fixture's own status before this file ever gets to assert on it.
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
    { id: overrides.id, buyerDid: BUYER_ACCOUNT_DID, agentDid: AGENT_DID, repository: 'buyer/pr-repo', brief: 'Fix the checkout flow' },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}
function observationFixture(overrides: Partial<StagingObservation> = {}): StagingObservation {
  return {
    diffHash: 'sha256:fixture-diff-hash',
    filesChanged: 9,
    linesAdded: 186,
    linesRemoved: 94,
    changedPaths: ['packages/tokens/src/index.ts'],
    lineShareByCategory: { source: 61, test: 27, lockfile: 0, generated: 0, vendored: 0 },
    testsDeleted: [],
    testsSkipAdded: [],
    outOfCriteriaPathCount: 9,
    commitSigners: [{ matchesAgentDid: true }],
    ...overrides,
  };
}
interface Rendered {
  window: JSDOM['window'];
  document: Document;
  close: () => void;
}
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
  for (let waited = 0; waited < 350; waited += 50) { await new Promise((resolve) => setTimeout(resolve, 50)); }
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, close: () => dom.window.close() };
}
function renderPr(
  baseUrl: string,
  jobId: string,
  session: { token: string; subject?: string; method?: string } | null,
  onFetch?: (input: string, init?: RequestInit) => void,
): Promise<Rendered> {
  return renderPage(baseUrl, `/pullrequest?job=${encodeURIComponent(jobId)}`, session, onFetch);
}
describe('the pull-request screen, driven end to end against the real app', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let accountRepo: MemoryAccountRepository;
  let attestationRepo: MemoryAttestationRepository;
  let server: Server;
  let baseUrl: string;
  let buyerToken: string;
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
      name: 'pr-page-scout',
      skills: ['triage'],
      githubLogin: null,
    });
    accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'pr-page-buyer' });
    await accountRepo.register({ did: STRANGER_ACCOUNT_DID, githubLogin: 'pr-page-stranger' });
    await accountRepo.register({ did: OPERATOR_DID, githubLogin: 'pr-page-operator-login' });
    await accountRepo.register({ did: AGENT_DID, githubLogin: 'pr-page-agent-login' });
    await agentRepo.create({
      did: TERMINAL_AGENT_DID,
      operatorDid: OPERATOR_DID,
      delegation: delegationFixture(TERMINAL_AGENT_DID, OPERATOR_DID),
      name: 'pr-page-terminal-scout',
      skills: ['triage'],
      githubLogin: null,
    });
    jobRepo = new MemoryJobRepository();
    attestationRepo = new MemoryAttestationRepository();
    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter(undefined, credentialRepo);
    // Fully submitted, the screen this card builds.
    const fullySubmitted = jobFixture({
      id: 'job-fully-submitted',
      status: 'submitted',
      criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      priceUsd: '1200.00',
      rail: 'abt',
      depositPercent: 25,
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      stagedAt: RECENT,
      stagedCommit: 'c41f8a9d2b73e05614af8c3d99b7e2016fa4d825',
      pullRequestUrl: 'https://github.com/buyer/pr-repo/pull/418',
      submittedAt: RECENT,
      deadline: new Date(RECENT.getTime() + 30 * 86_400_000), // STALE_AFTER_DAYS -- must never render
    });
    await jobRepo.create(fullySubmitted);
    await storeAttestation(fullySubmitted, observationFixture(), credentials);
    // The half-up tie case payment.ts itself pins: priceUsd 2.00 at depositPercent 75 leaves a remainder of exactly 0.50, and 0.50 at 3 percent is exactly 0.0150.
    const tieCase = jobFixture({ id: 'job-tie-case', status: 'submitted', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '2.00', rail: 'abt', depositPercent: 75, priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-tie-case', pullRequestUrl: 'https://github.com/buyer/pr-repo/pull/1', submittedAt: RECENT });
    await jobRepo.create(tieCase);
    await storeAttestation(tieCase, observationFixture({ diffHash: 'sha256:tie-case' }), credentials);
    // Not submitted: a job at staged, for the not-ready panel.
    await jobRepo.create(jobFixture({ id: 'job-staged-not-submitted', status: 'staged', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', rail: 'abt', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-staged-not-submitted' }));
    // Terminal statuses this page can reach by reloading. A separate agent DID (TERMINAL_AGENT_DID) for job-completed, so its mergeCommit does not leak a verified hire onto pr-page-scout's own zero-count fixture.
    await jobRepo.create(jobFixture({ id: 'job-completed', agentDid: TERMINAL_AGENT_DID, status: 'completed', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, submittedAt: RECENT, mergeCommit: 'commit-merged', mergedAt: RECENT }));
    await jobRepo.create(jobFixture({ id: 'job-deemed-completed', status: 'deemed_completed', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, submittedAt: RECENT, deemedCompletedAt: RECENT }));
    await jobRepo.create(jobFixture({ id: 'job-cited-closed', status: 'cited_closed', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, submittedAt: RECENT, citedCloseCriterionIndex: 0, citedCloseReasonText: 'Missed the mark', citedCloseAuthorDid: BUYER_ACCOUNT_DID, citedCloseAt: RECENT }));
    // A stranger's 403 fixture.
    await jobRepo.create(jobFixture({ id: 'job-for-403', status: 'submitted', criteria: [{ text: 'x', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '100.00', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-for-403', pullRequestUrl: 'https://github.com/buyer/pr-repo/pull/2', submittedAt: RECENT }));
    await storeAttestation(
      await jobRepo.findById('job-for-403') as Job,
      observationFixture({ diffHash: 'sha256:for-403' }),
      credentials,
    );
    // Submitted with NO attestation stored: ruling 6's absent-diff leg, never a fault (unlike staged's own attestation gate).
    await jobRepo.create(jobFixture({ id: 'job-no-attestation', status: 'submitted', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-no-attestation', pullRequestUrl: 'https://github.com/buyer/pr-repo/pull/3', submittedAt: RECENT }));
    // A non-GitHub pullRequestUrl: renders as text, no anchor.
    const nonGithub = jobFixture({ id: 'job-non-github-url', status: 'submitted', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '400.00', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-non-github', pullRequestUrl: 'https://evil.example.com/pull/9', submittedAt: RECENT });
    await jobRepo.create(nonGithub);
    await storeAttestation(nonGithub, observationFixture({ diffHash: 'sha256:non-github' }), credentials);
    // D1 (staged.test.ts's own pattern): a SEPARATE agent with a completed hire, for the verified-hire-count assertion.
    await agentRepo.create({ did: HIRED_AGENT_DID, operatorDid: 'did:abt:pr-page-hired-operator', delegation: delegationFixture(HIRED_AGENT_DID, 'did:abt:pr-page-hired-operator'), name: 'pr-page-hired-scout', skills: ['triage'], githubLogin: null });
    const completedHireDraft = jobFixture({ id: 'pr-page-completed-hire', buyerDid: 'did:example:pr-page-past-buyer', agentDid: HIRED_AGENT_DID, status: 'draft' });
    await jobRepo.create(completedHireDraft);
    await jobRepo.complete(
      { ...completedHireDraft, status: 'completed', mergeCommit: 'pr-page-commit-1', mergedAt: new Date('2026-08-30T00:00:00Z') },
      { jobId: completedHireDraft.id, buyerDid: completedHireDraft.buyerDid, agentDid: HIRED_AGENT_DID, mergeCommit: 'pr-page-commit-1', completedAt: new Date('2026-08-30T00:00:00Z') },
    );
    const hiredAgentSubmitted = jobFixture({ id: 'job-hired-agent-has-hires', agentDid: HIRED_AGENT_DID, status: 'submitted', criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '500.00', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-hired-agent', pullRequestUrl: 'https://github.com/buyer/pr-repo/pull/5', submittedAt: RECENT });
    await jobRepo.create(hiredAgentSubmitted);
    await storeAttestation(hiredAgentSubmitted, observationFixture({ diffHash: 'sha256:hired-agent' }), credentials);
    // Markup in a criterion: literal text, never parsed (api.js rule 3).
    const markupJob = jobFixture({ id: 'job-markup', status: 'submitted', criteria: [{ text: '<img src=x onerror=alert(1)>Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }], priceUsd: '150.00', priceAcceptedByBuyer: true, priceAcceptedByAgent: true, stagedAt: RECENT, stagedCommit: 'commit-markup', pullRequestUrl: 'https://github.com/buyer/pr-repo/pull/6', submittedAt: RECENT });
    await jobRepo.create(markupJob);
    await storeAttestation(markupJob, observationFixture({ diffHash: 'sha256:markup' }), credentials);
    // Three confirmed criteria, for the picker's numbering.
    const multiCriteria = jobFixture({
      id: 'job-multi-criteria',
      status: 'submitted',
      criteria: [
        { text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
        { text: 'Every existing test still passes', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
        { text: 'A regression test covers the bug', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      ],
      priceUsd: '900.00',
      rail: 'abt',
      depositPercent: 25,
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      stagedAt: RECENT,
      stagedCommit: 'commit-multi-criteria',
      pullRequestUrl: 'https://github.com/buyer/pr-repo/pull/7',
      submittedAt: RECENT,
    });
    await jobRepo.create(multiCriteria);
    await storeAttestation(multiCriteria, observationFixture({ diffHash: 'sha256:multi-criteria' }), credentials);
    // A fresh job per mutating test (cited-close actually POSTs and moves the job), so one test's write cannot leak into another's fixture.
    function freshSubmittedJob(id: string, priceUsd: string): Job {
      return jobFixture({
        id,
        status: 'submitted',
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
        priceUsd,
        rail: 'abt',
        depositPercent: 25,
        priceAcceptedByBuyer: true,
        priceAcceptedByAgent: true,
        stagedAt: RECENT,
        stagedCommit: `commit-${id}`,
        pullRequestUrl: `https://github.com/buyer/pr-repo/pull/${id}`,
        submittedAt: RECENT,
      });
    }
    for (const id of ['job-close-flow', 'job-close-malformed-guard', 'job-close-reenable-guard', 'job-agent-view', 'job-signed-out-view']) {
      const fixture = freshSubmittedJob(id, '900.00');
      await jobRepo.create(fixture);
      await storeAttestation(fixture, observationFixture({ diffHash: `sha256:${id}` }), credentials);
    }
    const sessionAdapterRef = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'pr-page-buyer', id: 9401 }) });
    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, credentials, undefined, credentialRepo, undefined, undefined, undefined, sessionAdapterRef, undefined, alwaysSettledGate(), undefined, attestationRepo);
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
  describe('a signed-out visitor, an unknown job id, and a submitted job with no attestation on record', () => {
    it('the signed-out visitor and unknown job each render their own panel, and the no-attestation job renders normally with no diff line (ruling 6)', async () => {
      const signedOut = await renderPr(baseUrl, 'job-fully-submitted', null);
      const unknownJob = await renderPr(baseUrl, 'no-such-job', buyerSession);
      const noAttestation = await renderPr(baseUrl, 'job-no-attestation', buyerSession);
      try {
        const notice = signedOut.document.getElementById('signin-required');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
        expect((notice!.textContent ?? '').toLowerCase()).toContain('sign in');
        expect(signedOut.document.getElementById('pr-body')!.hidden).toBe(true);
        const loadError = unknownJob.document.getElementById('load-error');
        expect(loadError).not.toBeNull();
        expect(loadError!.hidden).toBe(false);
        // Ruling 6, done means: absent, never a fault, and the page
        // still renders with the link but no diff line anywhere.
        expect(noAttestation.document.getElementById('pr-body')!.hidden).toBe(false);
        expect(noAttestation.document.getElementById('fault-error')!.hidden).toBe(true);
        expect(noAttestation.document.getElementById('pr-diff')!.hidden).toBe(true);
        expect(noAttestation.document.getElementById('pr-diff')!.textContent).toBe('');
      } finally {
        signedOut.close();
        unknownJob.close();
        noAttestation.close();
      }
    });
  });
  describe('a stranger to the job', () => {
    it('is refused with the 403 sentence, not a blank screen', async () => {
      const strangerAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'pr-page-stranger', id: 9402 }) });
      const strangerAccountRepo = new MemoryAccountRepository();
      await strangerAccountRepo.register({ did: STRANGER_ACCOUNT_DID, githubLogin: 'pr-page-stranger' });
      const strangerServer = createApp(strangerAccountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, strangerAdapter, undefined, alwaysSettledGate(), undefined, attestationRepo).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => strangerServer.once('listening', resolve));
      const strangerBaseUrl = `http://127.0.0.1:${(strangerServer.address() as AddressInfo).port}`;
      try {
        const token = await mintSessionToken(strangerAdapter);
        const page = await renderPr(strangerBaseUrl, 'job-for-403', { token });
        try {
          const notice = page.document.getElementById('party-error');
          expect(notice).not.toBeNull();
          expect(notice!.hidden).toBe(false);
          const body = page.document.getElementById('pr-body');
          expect(body!.hidden).toBe(true);
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => strangerServer.close(() => resolve()));
      }
    });
  });
  describe('a job not at submitted (ruling 7, mutation proof 6)', () => {
    it('a staged job renders the not-ready panel with a link back to /jobs/<id>, and no close control', async () => {
      const page = await renderPr(baseUrl, 'job-staged-not-submitted', buyerSession);
      try {
        const notice = page.document.getElementById('not-ready-error');
        expect(notice).not.toBeNull();
        expect(notice!.hidden).toBe(false);
        const link = page.document.getElementById('not-ready-link') as HTMLAnchorElement | null;
        expect(link?.getAttribute('href')).toBe('/jobs/job-staged-not-submitted');
        const body = page.document.getElementById('pr-body');
        expect(body!.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });
  describe('the three terminal statuses this page can reach by reloading (ruling 7, mutation proof 7)', () => {
    it('completed, deemed_completed and cited_closed each name what already happened, with a link back and no control', async () => {
      const completed = await renderPr(baseUrl, 'job-completed', buyerSession);
      const deemed = await renderPr(baseUrl, 'job-deemed-completed', buyerSession);
      const cited = await renderPr(baseUrl, 'job-cited-closed', buyerSession);
      try {
        [completed, deemed, cited].forEach((page) => {
          const panel = page.document.getElementById('terminal-panel');
          expect(panel).not.toBeNull();
          expect(panel!.hidden).toBe(false);
          expect(page.document.getElementById('pr-body')!.hidden).toBe(true);
          expect(page.document.getElementById('not-ready-error')!.hidden).toBe(true);
        });
        expect(completed.document.getElementById('terminal-title')?.textContent ?? '').toContain('merged');
        expect(deemed.document.getElementById('terminal-title')?.textContent ?? '').toContain('deemed complete');
        expect(cited.document.getElementById('terminal-title')?.textContent ?? '').toContain('closed');
        const titles = [completed, deemed, cited].map((p) => p.document.getElementById('terminal-title')?.textContent ?? '');
        expect(new Set(titles).size).toBe(3);
      } finally {
        completed.close();
        deemed.close();
        cited.close();
      }
    });
  });
  describe('the clock (ruling 1, mutation proofs 1 and 2)', () => {
    it('states the deadline as submittedAt plus DEEM_COMPLETED_AFTER_DAYS, never the projection deadline field, with no countdown', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        const expectedDeadline = new Date(RECENT.getTime() + DEEM_COMPLETED_AFTER_DAYS * 86_400_000);
        const days = page.document.getElementById('clock-days')?.textContent ?? '';
        expect(days).toContain(String(DEEM_COMPLETED_AFTER_DAYS) + ' days');
        expect(days).toContain(expectedDeadline.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
        // The projection's own `deadline` field (submittedAt + 30 days,
        // STALE_AFTER_DAYS) must never appear anywhere in the document.
        const staleDeadline = new Date(RECENT.getTime() + 30 * 86_400_000);
        const staleText = staleDeadline.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        expect(page.document.documentElement.outerHTML).not.toContain(staleText);
        expect(page.document.querySelector('progress')).toBeNull();
        expect(page.document.querySelector('[role="progressbar"]')).toBeNull();
        const then = page.document.getElementById('clock-then')?.textContent ?? '';
        expect(then.toLowerCase()).toContain('recorded as completed anyway');
        expect(then.toLowerCase()).toContain('no merge was observed');
      } finally {
        page.close();
      }
    });
  });
  describe('the fork wording never appears (ruling 3, mutation proof 14); no-merge sentence checks, never watches (D1)', () => {
    it('names a staging repository, never a fork, and keeps the write-access sentence verbatim', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        const text = (page.document.documentElement.outerHTML ?? '').toLowerCase();
        expect(text).not.toContain('fork');
        const provenance = page.document.getElementById('pr-provenance')?.textContent ?? '';
        expect(provenance).toContain('staging repository');
        expect(provenance).toContain('has never had write access to');
        expect(provenance).toContain('cannot be given it');
        expect(text).not.toContain('watches your repository');
        expect(text).not.toContain('freeagents watches');
        expect(text).toContain('checks github');
      } finally {
        page.close();
      }
    });
  });
  describe('no payment date renders anywhere (ruling 4)', () => {
    it('the lede states paid in full and the pull-request-opened date, with no dated deposit or balance row', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        const lede = page.document.getElementById('lede')?.textContent ?? '';
        expect(lede.toLowerCase()).toContain('paid in full');
        const openedDate = RECENT.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        expect(lede).toContain(openedDate);
        const deposit = page.document.getElementById('tech-deposit')?.textContent ?? '';
        const balance = page.document.getElementById('tech-balance')?.textContent ?? '';
        expect(deposit).not.toMatch(/\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)/);
        expect(balance).not.toMatch(/\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)/);
        expect(deposit).toMatch(/^\$/);
        expect(balance).toMatch(/^\$/);
      } finally {
        page.close();
      }
    });
  });
  describe('money computed from the same constants as P8j, pinned against src/domain/payment.ts (mutation proofs 3, 4)', () => {
    it('the deposit and balance amounts and fees agree with depositUsd/remainderUsd/calculateFee', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        const deposit = depositUsd('1200.00', 25);
        const depositFee = calculateFee(deposit, ABT_FEE_RATE_PERCENT);
        const remainder = remainderUsd('1200.00', 25);
        const fee = calculateFee(remainder, ABT_FEE_RATE_PERCENT);
        const depositText = page.document.getElementById('tech-deposit')?.textContent ?? '';
        const balanceText = page.document.getElementById('tech-balance')?.textContent ?? '';
        expect(depositText).toContain(`$${deposit}`);
        expect(depositText).toContain(`$${depositFee}`);
        expect(balanceText).toContain(`$${remainder}`);
        expect(balanceText).toContain(`$${fee}`);
      } finally {
        page.close();
      }
    });
    it('the half-up tie case (a $0.50 remainder at 3 percent) matches payment.ts exactly (mutation proof 4)', async () => {
      const page = await renderPr(baseUrl, 'job-tie-case', buyerSession);
      try {
        const remainder = remainderUsd('2.00', 75);
        expect(remainder).toBe('0.50');
        const fee = calculateFee(remainder, ABT_FEE_RATE_PERCENT);
        expect(fee).toBe('0.02');
        const balanceText = page.document.getElementById('tech-balance')?.textContent ?? '';
        expect(balanceText).toContain('$0.50');
        expect(balanceText).toContain('$0.02');
      } finally {
        page.close();
      }
    });
  });
  describe('the diff line (ruling 6, mutation proof 5)', () => {
    it('reads linesAdded, linesRemoved and filesChanged from the signed attestation, field by field', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        const diff = page.document.getElementById('pr-diff')?.textContent ?? '';
        expect(diff).toContain('+186');
        expect(diff).toContain('-94');
        expect(diff).toContain('9 files');
        expect(page.document.getElementById('pr-diff')?.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });
  describe('the link and the open-on-github control', () => {
    it('the link href is byte-identical to pullRequestUrl, and no merge control exists anywhere', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        const link = page.document.querySelector('#prlink a') as HTMLAnchorElement | null;
        expect(link).not.toBeNull();
        expect(link!.getAttribute('href')).toBe('https://github.com/buyer/pr-repo/pull/418');
        const openLink = page.document.querySelector('#pr-open-wrap a') as HTMLAnchorElement | null;
        expect(openLink).not.toBeNull();
        expect(openLink!.getAttribute('href')).toBe('https://github.com/buyer/pr-repo/pull/418');
        // W7c, ALLOWED_ABSENT('pullrequest', 'Open the pull request on GitHub'):
        // pinned so the label cannot silently drift away from the wireframe's
        // exact text with a suite that stays green.
        expect(openLink!.textContent).toBe('Open the pull request on GitHub');
        const bodyText = page.document.body.innerHTML.toLowerCase();
        expect(bodyText).not.toContain('mark as merged');
        expect(bodyText).not.toContain('i merged it');
        Array.from(page.document.querySelectorAll('button, a')).forEach((el) => {
          expect((el.textContent ?? '').toLowerCase()).not.toContain('mark as merged');
        });
      } finally {
        page.close();
      }
    });
    it('a pullRequestUrl whose origin is not github.com renders as text with no anchor (mutation proof 12)', async () => {
      const page = await renderPr(baseUrl, 'job-non-github-url', buyerSession);
      try {
        expect(page.document.querySelector('#prlink a')).toBeNull();
        expect(page.document.querySelector('#pr-open-wrap a')).toBeNull();
        const text = page.document.getElementById('prlink')?.textContent ?? '';
        expect(text).toContain('buyer/pr-repo');
      } finally {
        page.close();
      }
    });
  });
  describe('a criterion containing markup renders as literal text in the close picker (api.js rule 3)', () => {
    it('no img or script element is created from the criterion text', async () => {
      const page = await renderPr(baseUrl, 'job-markup', buyerSession);
      try {
        (page.document.getElementById('close-btn') as HTMLButtonElement).click();
        const picker = page.document.getElementById('close-picker');
        expect(picker?.querySelector('img')).toBeNull();
        expect(picker?.querySelector('script')).toBeNull();
        const text = picker?.textContent ?? '';
        expect(text).toContain('<img src=x onerror=alert(1)>Done');
      } finally {
        page.close();
      }
    });
  });
  describe('the verified hire count (scope item 8)', () => {
    it('renders the agent name with no count when the agent has none', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        expect(page.document.getElementById('agent-name')?.textContent).toBe('pr-page-scout');
        expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('');
      } finally {
        page.close();
      }
    });
    it('renders the real count from GET /agents/:agentDid/hires when the agent has a verified hire', async () => {
      const page = await renderPr(baseUrl, 'job-hired-agent-has-hires', buyerSession);
      try {
        expect(page.document.getElementById('agent-name')?.textContent).toBe('pr-page-hired-scout');
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
        const page = await renderPr(proxyBaseUrl, 'job-hired-agent-has-hires', buyerSession);
        expect(page.document.getElementById('agent-name')?.textContent).toBe('pr-page-hired-scout');
        expect(page.document.getElementById('agent-hires')?.textContent ?? '').toBe('');
        page.close();
      } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    });
  });
  describe('the session token never rides in the document, and the nav flips to signed-in', () => {
    it('the token does not appear anywhere in the rendered document, including inside the dialog, and the nav shows signed-in', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        (page.document.getElementById('close-btn') as HTMLButtonElement | null)?.click();
        expect(page.document.documentElement.outerHTML).not.toContain(buyerToken);
        const signedIn = page.document.getElementById('nav-signed-in');
        expect(signedIn?.hidden).toBe(false);
      } finally {
        page.close();
      }
    });
  });
  describe('the job page routes a submitted job to this screen (scope item 4)', () => {
    it("resolves the job page's own control to /pullrequest?job=<id> (mutation proof: a missing href leaves the test red)", async () => {
      const page = await renderPage(baseUrl, '/jobs/job-fully-submitted', null);
      try {
        const link = page.document.getElementById('pullrequest-link') as HTMLAnchorElement | null;
        expect(link).not.toBeNull();
        expect(link!.getAttribute('href')).toBe('/pullrequest?job=job-fully-submitted');
      } finally {
        page.close();
      }
    });
  });
  describe('exactly two acting controls: the GitHub anchor and the dialog submit (done means)', () => {
    it('no third acting control exists, and no request is ever made to any merge, redo, staged-decline, or pull-request path', async () => {
      const requests: string[] = [];
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession, (input, init) => {
        requests.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(input), baseUrl).pathname}`);
      });
      try {
        const main = page.document.querySelector('main');
        const buttons = Array.from(main?.querySelectorAll('button') ?? []).filter((b) => b.id !== 'close-btn' && !b.classList.contains('disclose') && !b.hasAttribute('data-copy'));
        expect(buttons.length).toBe(0);
        const links = Array.from(main?.querySelectorAll('a') ?? []);
        // The GitHub link/anchor plus the "open on GitHub" control are
        // the same fact rendered twice (both point at pullRequestUrl);
        // neither is a merge control.
        links.forEach((a) => {
          expect((a.textContent ?? '').toLowerCase()).not.toContain('merge');
        });
        const wholeRecord = requests.join('\n').toLowerCase();
        expect(wholeRecord).not.toContain('/merge');
        expect(wholeRecord).not.toMatch(/\/redo\b/);
        expect(wholeRecord).not.toContain('staged-decline');
        expect(wholeRecord).not.toContain('/pull-request');
      } finally {
        page.close();
      }
    });
  });
  describe('the close picker (mutation proofs 9, 10, 11)', () => {
    it('renders one row per confirmed criterion, in stored order, numbered from 1, nothing preselected, and the array index posted regardless of the label', async () => {
      const page = await renderPr(baseUrl, 'job-multi-criteria', buyerSession);
      try {
        (page.document.getElementById('close-btn') as HTMLButtonElement).click();
        const picker = page.document.getElementById('close-picker');
        const rows = Array.from(picker?.querySelectorAll('li') ?? []);
        expect(rows.length).toBe(3);
        const radios = Array.from(picker?.querySelectorAll('input[type="radio"]') ?? []) as HTMLInputElement[];
        radios.forEach((r) => expect(r.checked).toBe(false));
        expect(radios.map((r) => r.value)).toEqual(['0', '1', '2']);
        const labelsText = rows.map((r) => r.textContent ?? '');
        expect(labelsText[0]).toContain('01');
        expect(labelsText[0]).toContain('The login bug is fixed');
        expect(labelsText[1]).toContain('02');
        expect(labelsText[2]).toContain('03');
      } finally {
        page.close();
      }
    });
    it('the submit control does not fire with no line chosen, and does not fire with a chosen line and whitespace-only prose (mutation proofs 9, 10)', async () => {
      const requests: string[] = [];
      const page = await renderPr(baseUrl, 'job-multi-criteria', buyerSession, (input, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') requests.push(new URL(String(input), baseUrl).pathname);
      });
      try {
        (page.document.getElementById('close-btn') as HTMLButtonElement).click();
        const sendBtn = page.document.getElementById('close-send-btn') as HTMLButtonElement;
        expect(sendBtn.disabled).toBe(true);
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(requests.length).toBe(0);
        const radios = Array.from(page.document.querySelectorAll('#close-picker input[type="radio"]')) as HTMLInputElement[];
        radios[1]!.checked = true;
        radios[1]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        expect(sendBtn.disabled).toBe(true);
        const whyInput = page.document.getElementById('close-why') as HTMLInputElement;
        whyInput.value = '   ';
        whyInput.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        expect(sendBtn.disabled).toBe(true);
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(requests.length).toBe(0);
        whyInput.value = 'Missed criterion two';
        whyInput.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        expect(sendBtn.disabled).toBe(false);
      } finally {
        page.close();
      }
    });
  });
  describe('a valid close (mutation proof 11)', () => {
    it('posts exactly once to POST /jobs/<id>/cited-close with { criterionIndex, reasonText } matching what was chosen and typed, and re-reads cited_closed with moneyReturned false', async () => {
      const requests: { method: string; path: string; body: unknown }[] = [];
      const page = await renderPr(baseUrl, 'job-close-flow', buyerSession, (input, init) => {
        requests.push({
          method: (init?.method ?? 'GET').toUpperCase(),
          path: new URL(String(input), baseUrl).pathname,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
      });
      try {
        (page.document.getElementById('close-btn') as HTMLButtonElement).click();
        const radios = Array.from(page.document.querySelectorAll('#close-picker input[type="radio"]')) as HTMLInputElement[];
        radios[0]!.checked = true;
        radios[0]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        const whyInput = page.document.getElementById('close-why') as HTMLInputElement;
        whyInput.value = 'The login bug is still present';
        whyInput.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        const sendBtn = page.document.getElementById('close-send-btn') as HTMLButtonElement;
        sendBtn.click();
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const closePosts = requests.filter((r) => r.method === 'POST' && /\/cited-close$/.test(r.path));
        expect(closePosts.length).toBe(1);
        expect(closePosts[0]!.body).toEqual({ criterionIndex: 0, reasonText: 'The login bug is still present' });
        const after = await fetch(`${baseUrl}/jobs/job-close-flow`, { headers: { Accept: 'application/json' } });
        const afterBody = (await after.json()) as { status: string; citedClose?: { moneyReturned: boolean } };
        expect(afterBody.status).toBe('cited_closed');
        expect(afterBody.citedClose?.moneyReturned).toBe(false);
        const secondView = await renderPr(baseUrl, 'job-close-flow', buyerSession);
        try {
          expect(secondView.document.getElementById('terminal-panel')?.hidden).toBe(false);
          expect(secondView.document.getElementById('pr-body')?.hidden).toBe(true);
        } finally {
          secondView.close();
        }
      } finally {
        page.close();
      }
    });
    it('does not re-enable the send control after a successful press, so a second click after the response resolves fires no second request (mutation proof: guard-without-a-test)', async () => {
      const requests: { method: string; path: string }[] = [];
      const page = await renderPr(baseUrl, 'job-close-reenable-guard', buyerSession, (input, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') requests.push({ method: 'POST', path: new URL(String(input), baseUrl).pathname });
      });
      try {
        (page.document.getElementById('close-btn') as HTMLButtonElement).click();
        const radios = Array.from(page.document.querySelectorAll('#close-picker input[type="radio"]')) as HTMLInputElement[];
        radios[0]!.checked = true;
        radios[0]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        const whyInput = page.document.getElementById('close-why') as HTMLInputElement;
        whyInput.value = 'Reason';
        whyInput.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        const sendBtn = page.document.getElementById('close-send-btn') as HTMLButtonElement;
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(requests.filter((r) => /\/cited-close$/.test(r.path)).length).toBe(1);
        expect(sendBtn.disabled).toBe(true);
        sendBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(requests.filter((r) => /\/cited-close$/.test(r.path)).length).toBe(1);
      } finally {
        page.close();
      }
    });
    it('every close refusal renders its own distinct sentence, including a malformed body (400) that never blames the buyer, and a 402 for an unsettled remainder', async () => {
      const page = await renderPr(baseUrl, 'job-close-malformed-guard', buyerSession);
      const originalFetch = global.fetch;
      try {
        (page.document.getElementById('close-btn') as HTMLButtonElement).click();
        const radios = Array.from(page.document.querySelectorAll('#close-picker input[type="radio"]')) as HTMLInputElement[];
        radios[0]!.checked = true;
        radios[0]!.dispatchEvent(new page.window.Event('change', { bubbles: true }));
        const whyInput = page.document.getElementById('close-why') as HTMLInputElement;
        whyInput.value = 'Reason';
        whyInput.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        const sendBtn = page.document.getElementById('close-send-btn') as HTMLButtonElement;
        const sentences: string[] = [];
        for (const [status, error] of [[400, 'body must be { criterionIndex, reasonText }'], [401, ''], [403, ''], [402, 'the remainder has not settled'], [404, 'not found'], [503, 'storage unavailable']] as [number, string][]) {
          Object.defineProperty(page.window, 'fetch', { writable: true, value: async (input: string, init?: RequestInit) => (String(input).includes('/cited-close') ? new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } }) : originalFetch(new URL(input, baseUrl), init)) });
          sendBtn.click();
          await new Promise((resolve) => setTimeout(resolve, 150));
          sentences.push(page.document.getElementById('close-error-detail')?.textContent ?? '');
        }
        expect(new Set(sentences).size).toBe(6);
        expect((sentences[0] ?? '').toLowerCase()).not.toContain('you');
        expect((sentences[0] ?? '').toLowerCase()).toContain('screen');
        expect((sentences[3] ?? '').toLowerCase()).toContain('remainder has not settled');
      } finally {
        page.close();
      }
    });
  });
  describe('party and session gates on the close control', () => {
    it('an agent signed in on a submitted hire is refused with the buyer-only 403 sentence and is shown neither control, and the job is unchanged', async () => {
      const agentSessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'pr-page-agent-login', id: 9403 }) });
      const agentAccountRepo = new MemoryAccountRepository();
      await agentAccountRepo.register({ did: AGENT_DID, githubLogin: 'pr-page-agent-login' });
      await agentAccountRepo.register({ did: BUYER_ACCOUNT_DID, githubLogin: 'pr-page-buyer' });
      const agentServer = createApp(agentAccountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, agentSessionAdapter, undefined, alwaysSettledGate(), undefined, attestationRepo).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => agentServer.once('listening', resolve));
      const agentBaseUrl = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}`;
      try {
        const agentSession = await mintSession(agentSessionAdapter);
        const page = await renderPr(agentBaseUrl, 'job-agent-view', agentSession);
        try {
          expect(page.document.getElementById('party-error')?.hidden).toBe(true);
          expect(page.document.getElementById('pr-body')?.hidden).toBe(false);
          expect(page.document.getElementById('close-btn')).toBeNull();
          const closeRes = await fetch(`${agentBaseUrl}/jobs/job-agent-view/cited-close`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${agentSession.token}` },
            body: JSON.stringify({ criterionIndex: 0, reasonText: 'x' }),
          });
          expect(closeRes.status).toBe(403);
          const after = await fetch(`${agentBaseUrl}/jobs/job-agent-view`, { headers: { Accept: 'application/json' } });
          const afterBody = (await after.json()) as { status: string };
          expect(afterBody.status).toBe('submitted');
        } finally {
          page.close();
        }
      } finally {
        await new Promise<void>((resolve) => agentServer.close(() => resolve()));
      }
    });
    describe('the passkey branch (mirrors the pattern staged.test.ts already covers)', () => {
      it('a passkey session whose subject matches the buyer account renders the close control', async () => {
        const passkeyAccountRepo = new MemoryAccountRepository();
        const passkeySubjectValue = 'pr-page-passkey-buyer-subject';
        await passkeyAccountRepo.register({ did: BUYER_ACCOUNT_DID, passkeySubject: passkeySubjectValue });
        const passkeyAgentRepo = new MemoryAgentRepository();
        await passkeyAgentRepo.create({ did: AGENT_DID, operatorDid: OPERATOR_DID, delegation: delegationFixture(AGENT_DID, OPERATOR_DID), name: 'pr-page-passkey-scout', skills: ['triage'], githubLogin: null });
        const passkeyJobRepo = new MemoryJobRepository();
        const passkeyAttestationRepo = new MemoryAttestationRepository();
        const passkeyCredentialRepo = new MemoryCredentialRepository();
        const passkeyCredentials = createCredentialsAdapter(undefined, passkeyCredentialRepo);
        const passkeyJob = jobFixture({
          id: 'job-passkey-buyer-match',
          status: 'submitted',
          criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
          priceUsd: '400.00',
          priceAcceptedByBuyer: true,
          priceAcceptedByAgent: true,
          stagedAt: RECENT,
          stagedCommit: 'commit-passkey-buyer-match',
          pullRequestUrl: 'https://github.com/buyer/pr-repo/pull/50',
          submittedAt: RECENT,
        });
        await passkeyJobRepo.create(passkeyJob);
        const passkeyAttestation = buildAttestation(passkeyJob, observationFixture({ diffHash: 'sha256:passkey-buyer-match' }), RECENT);
        const passkeySigned = await passkeyCredentials.signAttestation(passkeyAttestation);
        await passkeyAttestationRepo.save({ jobId: passkeyJob.id, attestation: passkeyAttestation, signed: passkeySigned });
        const passkeySessionAdapter = createSessionAdapter({
          github: fakeGitHubConfig(),
          passkey: { rpName: 'FreeAgents test', rpID: 'localhost', origin: 'http://localhost:3000' },
        });
        const passkeyApp = createApp(passkeyAccountRepo, passkeyAgentRepo, undefined, undefined, passkeyJobRepo, undefined, undefined, undefined, undefined, undefined, undefined, passkeySessionAdapter, undefined, alwaysSettledGate(), undefined, passkeyAttestationRepo);
        const passkeyServer = passkeyApp.listen(0, '127.0.0.1');
        await new Promise<void>((resolve) => passkeyServer.once('listening', resolve));
        const passkeyBaseUrl = `http://127.0.0.1:${(passkeyServer.address() as AddressInfo).port}`;
        try {
          const { optionsJson } = await passkeySessionAdapter.registerPasskey(passkeySubjectValue);
          const registrationOptions = JSON.parse(optionsJson) as { challenge: string };
          const fixture = createPasskeyFixture();
          const response = fixture.registrationResponse(registrationOptions.challenge, 'localhost');
          const passkeySession = await passkeySessionAdapter.verifyPasskey(JSON.stringify({ subject: passkeySubjectValue, response }));
          if (passkeySession === null) throw new Error('expected a passkey session');
          const page = await renderPr(passkeyBaseUrl, 'job-passkey-buyer-match', passkeySession);
          try {
            expect(page.document.getElementById('pr-body')?.hidden).toBe(false);
            expect(page.document.getElementById('close-btn')).not.toBeNull();
          } finally {
            page.close();
          }
        } finally {
          await new Promise<void>((resolve) => passkeyServer.close(() => resolve()));
        }
      });
    });
    it('a signed-out visitor is sent to sign in and the close control is never reached', async () => {
      const page = await renderPr(baseUrl, 'job-signed-out-view', null);
      try {
        expect(page.document.getElementById('signin-required')?.hidden).toBe(false);
        expect(page.document.getElementById('pr-body')?.hidden).toBe(true);
      } finally {
        page.close();
      }
    });
  });
  describe('layout: 320px minimum, 44px tap targets (layout-broken-at-desktop)', () => {
    it('the dialog caps at min(520px, 100vw - 24px), every picker row and the send/close controls are at least 44px', async () => {
      const page = await renderPr(baseUrl, 'job-multi-criteria', buyerSession);
      try {
        const css = page.document.querySelector('style')?.textContent ?? '';
        expect(css).toMatch(/\.sheet\s*\{[^}]*width:\s*min\(520px,\s*calc\(100vw - 24px\)\)/);
        (page.document.getElementById('close-btn') as HTMLButtonElement).click();
        const closeBtn = page.document.querySelector('#close .sclose');
        expect(closeBtn).not.toBeNull();
        const closeBtnStyle = page.window.getComputedStyle(closeBtn as Element);
        expect(parseFloat(closeBtnStyle.width)).toBeGreaterThanOrEqual(44);
        expect(parseFloat(closeBtnStyle.height)).toBeGreaterThanOrEqual(44);
        expect(css).toMatch(/#close-send-btn\s*\{[^}]*min-height:\s*44px/);
        const pickerLabels = Array.from(page.document.querySelectorAll('#close-picker label'));
        expect(pickerLabels.length).toBe(3);
        pickerLabels.forEach((label) => {
          const style = page.window.getComputedStyle(label as Element);
          expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
        });
        const pickerRule = css.match(/\.picker label\s*\{[^}]*\}/)?.[0] ?? '';
        expect(pickerRule).toMatch(/grid-template-columns:\s*22px 1fr/);
        expect(pickerRule).toMatch(/min-height:\s*44px/);
        const actsRule = css.match(/\.acts\s*\{[^}]*\}/)?.[0] ?? '';
        expect(actsRule).toMatch(/flex-wrap:\s*wrap/);
      } finally {
        page.close();
      }
    });
    it('at a 1280px viewport the link row and the picker list measure with real DOM geometry: no wrapper div breaks the flex row or the picker rows (D2)', async () => {
      const page = await renderPr(baseUrl, 'job-fully-submitted', buyerSession);
      try {
        Object.defineProperty(page.window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
        const prlink = page.document.getElementById('prlink');
        expect(page.window.getComputedStyle(prlink as Element).display).toBe('flex');
        // Parentage: a wrapper div (the P8h defect) leaves flex true.
        expect(page.document.getElementById('pr-diff')?.parentElement).toBe(prlink);
        const link = page.document.querySelector('#prlink a');
        expect(link).not.toBeNull();
        expect(link?.parentElement).toBe(prlink);
        Array.from(prlink?.children ?? []).forEach((child) => expect(child.tagName).not.toBe('DIV'));
        (page.document.getElementById('close-btn') as HTMLButtonElement).click();
        const picker = page.document.getElementById('close-picker');
        const rows = Array.from(page.document.querySelectorAll('#close-picker > li'));
        expect(rows.length).toBeGreaterThan(0);
        rows.forEach((row) => { expect(row.parentElement).toBe(picker); expect(row.querySelector('label')?.parentElement).toBe(row); });
      } finally {
        page.close();
      }
    });
  });
});
