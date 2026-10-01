// FIX-B60 (B60): a merge on GitHub is recorded when a signed-in
// party opens the hire. Before this, only a signed POST /jobs/:jobId/merge
// ever asked GitHub, so a buyer who paid and merged entirely from the site
// never got a merge receipt; after seven days the job was deemed complete
// with the receipt that says no merge was observed.
//
// Now the job page, the pull request page and the owner's job page each
// ask once per load, for a submitted job and a signed-in viewer, through
// api.js checkMerge. The route reads GitHub itself (ENT-7.1), so the page
// asks and the server observes; no party's word is taken as a merge.
//
// Every page here is driven against the real app through createApp, with
// the shared GitHub fake scripted per pull request. Counts are exact:
// "exactly one merge request", never "at least one".
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { PullRequestRef } from '../../src/adapters/github/types.js';
import type { DidDocument, IdentityAdapter } from '../../src/adapters/identity/types.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryAttestationRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';
import { createStagingLifecycleGithubFake, type StagingLifecycleFixture } from '../helpers/github-staging-fixtures.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const TIMEOUT_MS = 30_000;

const AGENT_DID = 'did:abt:on-open-agent';
const BUYER_DID = 'did:abt:on-open-buyer';
const OPERATOR_DID = 'did:abt:on-open-operator';
const STRANGER_DID = 'did:abt:on-open-stranger';
const LOGINS = { buyer: 'on-open-buyer', operator: 'on-open-operator', stranger: 'on-open-stranger' } as const;
const AGENT_LOGIN = 'on-open-agent-login';
const OWNER = 'buyer';
const REPO = 'on-open';

// Recent, not fixed: GET /jobs/:jobId runs the live lapse clocks on every
// read, and a submittedAt older than DEEM_COMPLETED_AFTER_DAYS would flip
// the fixture to deemed_completed before any page drew it.
const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const MERGED_AT = new Date(Date.now() - 10 * 60 * 1000);
const DAY_MS = 86_400_000;

// The sentences each page draws, read here from the page scripts' own
// words so a pin names what a person sees.
const JOB_SUBMITTED = 'A pull request is open. The platform checks GitHub for a merge or close when either side opens this hire.';
const JOB_COMPLETED = 'The work merged. This hire is complete.';
const JOB_CLOSED = 'The pull request was closed without merging.';
const JOB_STALE = "The pull request has sat open past the platform's staleness window.";
const PR_COMPLETED = 'This hire is complete. The pull request merged.';
const OPJ_SUBMITTED_LEDE = 'The platform checks GitHub for a merge or close when either side opens this hire.';

// The same third-party check tests/api/job-merge-github-session-invariant2.test.ts
// makes: the key comes from the proof's own verificationMethod, it must
// belong to the claimed issuer DID, and the off-the-shelf W3C stack does
// the rest. No call to this service.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);
    const fingerprint = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });
    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    if (fromPublicKey(keyWithBuffer._publicKeyBuffer) !== issuer.replace(/^did:abt:/, '')) return false;
    key.controller = issuer;
    key.id = verificationMethod;
    const loader = securityLoader();
    loader.addStatic(key.id, { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
      assertionMethod: [key.id],
      verificationMethod: [{ '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) }],
    });
    const result = await vc.verifyCredential({ credential, suite: new Ed25519Signature2020(), documentLoader: loader.build() });
    return result.verified === true;
  } catch {
    return false;
  }
}

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

// One pull request number per job, so each job's GitHub reads are counted
// on their own ref.
let nextPr = 1;
const prFor = new Map<string, number>();

function jobAt(id: string, status: JobStatus): Job {
  const n = nextPr++;
  prFor.set(id, n);
  const base = createJob({ id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: `${OWNER}/${REPO}`, brief: 'Fix the login bug' }, RECENT);
  return {
    ...base,
    status,
    criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    priceUsd: '400.00',
    rail: 'abt',
    depositPercent: 25,
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    confirmedSpecHash: 'sha256:on-open-spec',
    confirmedAt: RECENT,
    stagedAt: RECENT,
    stagedCommit: `commit-${id}`,
    pullRequestUrl: `https://github.com/${OWNER}/${REPO}/pull/${n}`,
    submittedAt: RECENT,
    deadline: new Date(RECENT.getTime() + 30 * DAY_MS),
  };
}

function refFor(id: string): PullRequestRef {
  const n = prFor.get(id);
  if (n === undefined) throw new Error(`no pull request number for ${id}`);
  return { owner: OWNER, repo: REPO, number: n };
}

interface Rendered {
  readonly document: Document;
  // `${METHOD} ${path}` for every request the page sent, in order.
  readonly requests: string[];
  // The status each POST .../merge came back with, in order.
  readonly mergeStatuses: number[];
  readonly errors: string[];
  close(): void;
}

// Renders one page, then waits until nothing the page sent is still in
// flight (four quiet polls in a row), so a re-read that follows the merge
// answer is part of what is measured. `withoutHelper` removes
// FAApi.checkMerge before any page script runs: that is the page exactly
// as it would be with the helper deleted, the baseline pin (b) compares to.
async function renderPage(baseUrl: string, path: string, session: Session | null, withoutHelper = false): Promise<Rendered> {
  const requests: string[] = [];
  const mergeStatuses: number[] = [];
  const errors: string[] = [];
  let inFlight = 0;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(`jsdom: ${error.message}`));
  const onUnhandled = (reason: unknown): void => { errors.push(`unhandled: ${String(reason)}`); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const markup = await (await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } })).text();
    const dom = new JSDOM(markup, {
      url: `${baseUrl}${path}`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        if (session !== null) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
        if (withoutHelper) {
          let api: Record<string, unknown> | undefined;
          Object.defineProperty(window, 'FAApi', {
            configurable: true,
            get: () => api,
            set: (value: Record<string, unknown>) => {
              const copy = { ...value };
              delete copy.checkMerge;
              // The pages call A.checkMerge unconditionally; a no-op keeps
              // the rest of each page's script running exactly as before.
              api = { ...copy, checkMerge: () => null };
            },
          });
        }
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: async (input: string, init?: RequestInit) => {
            const url = new URL(String(input), baseUrl);
            const method = (init?.method ?? 'GET').toUpperCase();
            requests.push(`${method} ${url.pathname}`);
            inFlight += 1;
            try {
              const res = await fetch(url, init);
              await res.clone().arrayBuffer();
              if (method === 'POST' && url.pathname.endsWith('/merge')) mergeStatuses.push(res.status);
              return res;
            } finally {
              inFlight -= 1;
            }
          },
        });
      },
    });
    await new Promise<void>((resolve) => {
      if (dom.window.document.readyState === 'complete') resolve();
      else dom.window.addEventListener('load', () => resolve());
    });
    let quiet = 0;
    const deadline = Date.now() + 8000;
    await new Promise((resolve) => setTimeout(resolve, 150));
    while (quiet < 4) {
      if (Date.now() > deadline) throw new Error(`${path}: ${inFlight} request(s) still in flight after 8000ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      quiet = inFlight === 0 ? quiet + 1 : 0;
    }
    return { document: dom.window.document, requests, mergeStatuses, errors, close: () => dom.window.close() };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

// What a person can read in <main>: text under any element carrying
// `hidden` is left out, so a panel shown or hidden changes this value.
function visibleMain(document: Document): string {
  const main = document.querySelector('main');
  if (main === null) throw new Error('the page has no <main>');
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) { parts.push(node.nodeValue ?? ''); return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (el.hasAttribute('hidden') || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') return;
    el.childNodes.forEach(walk);
  };
  walk(main);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function mergeRequests(page: Rendered): string[] {
  return page.requests.filter((r) => /\/merge(\b|$)/.test(r));
}

describe('a signed-in party opening a submitted hire asks the platform to look at GitHub once (FIX-B60)', () => {
  let server: Server;
  let baseUrl: string;
  let fake: StagingLifecycleFixture;
  let jobRepo: MemoryJobRepository;
  const sessions = {} as Record<keyof typeof LOGINS, Session>;

  const readsOf = (id: string): number => {
    const ref = refFor(id);
    return fake.calls.getPullRequest.filter((r) => r.owner === ref.owner && r.repo === ref.repo && r.number === ref.number).length;
  };
  const scriptPr = (id: string, state: 'open' | 'closed' | 'merged'): void => {
    const n = prFor.get(id)!;
    fake.setPullRequest(refFor(id), {
      state,
      mergeCommitSha: state === 'merged' ? `merge-commit-${n}` : null,
      mergedAt: state === 'merged' ? MERGED_AT : null,
      headSha: `commit-${id}`,
      additions: 12,
      deletions: 3,
      filesChanged: 2,
      repositoryPublic: true,
      headRepoOwner: AGENT_LOGIN,
      headRepoFullName: `${AGENT_LOGIN}/${REPO}`,
      headRepoIsFork: true,
      baseRepoFullName: `${OWNER}/${REPO}`,
      authorLogin: AGENT_LOGIN,
      body: `Job: ${id}\n`,
    });
  };
  const readJob = async (id: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`${baseUrl}/jobs/${id}`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const addJob = async (id: string, status: JobStatus = 'submitted', over: Partial<Job> = {}): Promise<void> => {
    await jobRepo.create({ ...jobAt(id, status), ...over });
  };

  beforeAll(async () => {
    const issuerSeed = crypto.getRandomValues(new Uint8Array(32));
    const issuerKey = await Ed25519VerificationKey2020.generate({ seed: issuerSeed, controller: 'did:abt:pending' });
    const issuerDid = `did:abt:${fromPublicKey((issuerKey as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer)}`;

    const identity: IdentityAdapter = {
      createOperatorDid: () => Promise.reject(new NotImplementedError('identity', 'createOperatorDid')),
      createAgentDid: () => Promise.reject(new NotImplementedError('identity', 'createAgentDid')),
      resolveDid: (did: string): Promise<DidDocument> => Promise.resolve({ id: did, controller: null, verificationMethod: [`${did}#key-1`], alsoKnownAs: null }),
      sign: () => Promise.reject(new NotImplementedError('identity', 'sign')),
      verify: () => Promise.reject(new NotImplementedError('identity', 'verify')),
      verifyDelegation: () => Promise.resolve(true),
    };

    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: BUYER_DID, githubLogin: LOGINS.buyer });
    await accountRepo.register({ did: OPERATOR_DID, githubLogin: LOGINS.operator });
    await accountRepo.register({ did: STRANGER_DID, githubLogin: LOGINS.stranger });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({ did: AGENT_DID, operatorDid: OPERATOR_DID, delegation: delegationFixture(AGENT_DID, OPERATOR_DID), name: 'on-open-scout', skills: ['triage'], githubLogin: AGENT_LOGIN });

    jobRepo = new MemoryJobRepository();
    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter({ did: issuerDid, seed: issuerSeed }, credentialRepo);
    fake = createStagingLifecycleGithubFake();

    // One session adapter, so every minted token resolves on the same app;
    // which login GitHub reports is switched before each mint.
    let login: string = LOGINS.buyer;
    const sessionAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => fakeGitHubFetch({ login, id: login.length * 1000 + 7 })(input, init)) as typeof fetch,
    });
    for (const who of Object.keys(LOGINS) as (keyof typeof LOGINS)[]) {
      login = LOGINS[who];
      sessions[who] = await mintSession(sessionAdapter);
    }

    server = createApp(
      accountRepo, agentRepo, identity, fake.github, jobRepo, credentials, undefined, credentialRepo,
      // Generous buckets: this file loads about thirty pages from one
      // address inside a minute, far more than any single visitor would.
      { upstream: 1000, write: 1000, read: 10_000 },
      undefined, undefined, sessionAdapter, undefined, alwaysSettledGate(), undefined, new MemoryAttestationRepository(),
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('(a) GitHub says merged: the page shows the completed hire and its receipt', () => {
    it('the job page, on the buyer\'s session, and (g) the receipt verifies with the W3C stack alone', async () => {
      const id = 'mo-job-merged';
      await addJob(id);
      scriptPr(id, 'merged');
      const page = await renderPage(baseUrl, `/jobs/${id}`, sessions.buyer);
      try {
        expect(page.errors).toEqual([]);
        expect(mergeRequests(page)).toEqual([`POST /jobs/${id}/merge`]);
        expect(page.mergeStatuses).toEqual([200]);
        expect(readsOf(id)).toBe(1);
        const after = await readJob(id);
        expect(after.status).toBe('completed');
        expect(typeof after.credential).toBe('object');

        const doc = page.document;
        expect(doc.getElementById('state-label')?.textContent).toBe(JOB_COMPLETED);
        expect(doc.getElementById('credential-section')?.hidden).toBe(false);
        const credentialId = String((after.credential as Record<string, unknown>).id);
        expect(doc.getElementById('credential-link')?.getAttribute('href')).toBe(new URL(credentialId, baseUrl).pathname);
        expect(doc.getElementById('pullrequest-cta')?.hidden).toBe(true);
        const shown = visibleMain(doc);
        expect(shown).not.toContain(JOB_SUBMITTED);
        // The history is drawn once, from the re-read: one merge row and no
        // row repeated from the first render.
        const rows = Array.from(doc.querySelectorAll('#history .lbl')).map((n) => n.textContent ?? '');
        expect(rows.filter((r) => r === 'Merged, confirmed by checking GitHub')).toHaveLength(1);
        expect(new Set(rows).size).toBe(rows.length);

        // (g) Invariant 2: the credential this page load produced verifies
        // with no call to this service, and a tampered copy does not.
        const credential = after.credential as Record<string, unknown>;
        expect(await verifyIndependent(credential)).toBe(true);
        const tampered = JSON.parse(JSON.stringify(credential)) as Record<string, unknown>;
        ((tampered.credentialSubject as Record<string, unknown>).hire as Record<string, unknown>).additions = 999999;
        expect(await verifyIndependent(tampered)).toBe(false);
      } finally {
        page.close();
      }
    }, TIMEOUT_MS);

    it('the pull request page, on the buyer\'s session', async () => {
      const id = 'mo-pr-merged';
      await addJob(id);
      scriptPr(id, 'merged');
      const page = await renderPage(baseUrl, `/pullrequest?job=${id}`, sessions.buyer);
      try {
        expect(page.errors).toEqual([]);
        expect(mergeRequests(page)).toEqual([`POST /jobs/${id}/merge`]);
        expect(page.mergeStatuses).toEqual([200]);
        expect(readsOf(id)).toBe(1);
        const after = await readJob(id);
        expect(after.status).toBe('completed');
        expect(typeof after.credential).toBe('object');

        const doc = page.document;
        expect(doc.getElementById('terminal-panel')?.hidden).toBe(false);
        expect(doc.getElementById('terminal-title')?.textContent).toBe(PR_COMPLETED);
        expect(doc.getElementById('terminal-link')?.getAttribute('href')).toBe(`/jobs/${id}`);
        expect(doc.getElementById('pr-body')?.hidden).toBe(true);
        const shown = visibleMain(doc);
        expect(shown).not.toContain('Paid in full');
        expect(shown).not.toContain('to review');
        expect(shown).not.toContain('Close it with a reason');
      } finally {
        page.close();
      }
    }, TIMEOUT_MS);

    it('the owner\'s job page, on the operator\'s session', async () => {
      const id = 'mo-opj-merged';
      await addJob(id);
      scriptPr(id, 'merged');
      const page = await renderPage(baseUrl, `/operatorjob?job=${id}`, sessions.operator);
      try {
        expect(page.errors).toEqual([]);
        expect(mergeRequests(page)).toEqual([`POST /jobs/${id}/merge`]);
        expect(page.mergeStatuses).toEqual([200]);
        expect(readsOf(id)).toBe(1);
        const after = await readJob(id);
        expect(after.status).toBe('completed');
        expect(typeof after.credential).toBe('object');

        const doc = page.document;
        expect(doc.getElementById('operatorjob-body')?.hidden).toBe(false);
        expect(doc.getElementById('state-heading')?.textContent).toBe('This hire is complete');
        expect(doc.getElementById('state-lede')?.textContent).toBe('The work merged.');
        const rows = Array.from(doc.querySelectorAll('#history .lbl')).map((n) => n.textContent ?? '');
        expect(rows.filter((r) => r === 'Merged')).toHaveLength(1);
        const shown = visibleMain(doc);
        expect(shown).not.toContain('A pull request is open');
        expect(shown).not.toContain(OPJ_SUBMITTED_LEDE);
      } finally {
        page.close();
      }
    }, TIMEOUT_MS);
  });

  describe('the route records a stale pull request and refuses to record a closed one, and the job page shows the resulting status', () => {
    // B71: this case used to pin the route recording closed_unmerged and the
    // page showing JOB_CLOSED. A plain close no longer ends a paid job: the
    // merge request answers 409, the row stays submitted, and the page keeps
    // the submitted sentence.
    it('closed on GitHub: the merge request answers 409 and the job page keeps the submitted sentence, never closed or completed', async () => {
      const id = 'mo-job-closed';
      await addJob(id);
      scriptPr(id, 'closed');
      const page = await renderPage(baseUrl, `/jobs/${id}`, sessions.buyer);
      try {
        expect(page.errors).toEqual([]);
        expect(mergeRequests(page)).toEqual([`POST /jobs/${id}/merge`]);
        expect(page.mergeStatuses).toEqual([409]);
        expect((await readJob(id)).status).toBe('submitted');
        expect(page.document.getElementById('state-label')?.textContent).toBe(JOB_SUBMITTED);
        expect(page.document.getElementById('credential-section')?.hidden).toBe(true);
        const shown = visibleMain(page.document);
        expect(shown).not.toContain(JOB_CLOSED);
        expect(shown).not.toContain(JOB_COMPLETED);
      } finally {
        page.close();
      }
    }, TIMEOUT_MS);

    it('open past the 30-day deadline: the job page shows stale', async () => {
      const id = 'mo-job-stale';
      await addJob(id, 'submitted', { deadline: new Date(Date.now() - DAY_MS) });
      scriptPr(id, 'open');
      const page = await renderPage(baseUrl, `/jobs/${id}`, sessions.buyer);
      try {
        expect(page.errors).toEqual([]);
        expect(mergeRequests(page)).toEqual([`POST /jobs/${id}/merge`]);
        expect(page.mergeStatuses).toEqual([200]);
        expect((await readJob(id)).status).toBe('stale');
        expect(page.document.getElementById('state-label')?.textContent).toBe(JOB_STALE);
      } finally {
        page.close();
      }
    }, TIMEOUT_MS);
  });

  describe('(b) GitHub says still open: one request, and the page is what it would be with no helper', () => {
    const cases: Array<[string, (id: string) => string, keyof typeof LOGINS]> = [
      ['the job page', (id) => `/jobs/${id}`, 'buyer'],
      ['the pull request page', (id) => `/pullrequest?job=${id}`, 'buyer'],
      ['the owner\'s job page', (id) => `/operatorjob?job=${id}`, 'operator'],
    ];
    for (const [label, path, who] of cases) {
      it(label, async () => {
        const id = `mo-open-${who}-${path('x').split(/[/?]/)[1]}`;
        await addJob(id);
        scriptPr(id, 'open');
        const baseline = await renderPage(baseUrl, path(id), sessions[who], true);
        const page = await renderPage(baseUrl, path(id), sessions[who]);
        try {
          expect(baseline.errors).toEqual([]);
          expect(page.errors).toEqual([]);
          expect(mergeRequests(baseline)).toEqual([]);
          expect(mergeRequests(page)).toEqual([`POST /jobs/${id}/merge`]);
          expect(page.mergeStatuses).toEqual([409]);
          expect(readsOf(id)).toBe(1);
          expect((await readJob(id)).status).toBe('submitted');
          expect(visibleMain(page.document)).toBe(visibleMain(baseline.document));
          expect(page.document.querySelector('.empty.warn:not([hidden])')).toBeNull();
        } finally {
          baseline.close();
          page.close();
        }
      }, TIMEOUT_MS);
    }
  });

  describe('(c) a signed-out visitor on the job page', () => {
    it('sends no merge request, even when GitHub would say merged', async () => {
      const id = 'mo-signed-out';
      await addJob(id);
      scriptPr(id, 'merged');
      const page = await renderPage(baseUrl, `/jobs/${id}`, null);
      try {
        expect(page.errors).toEqual([]);
        expect(page.document.getElementById('state-label')?.textContent).toBe(JOB_SUBMITTED);
        expect(mergeRequests(page)).toEqual([]);
        expect(readsOf(id)).toBe(0);
        expect((await readJob(id)).status).toBe('submitted');
      } finally {
        page.close();
      }
    }, TIMEOUT_MS);
  });

  describe('(d) a job at any other status the job page renders', () => {
    const others: JobStatus[] = ['proposed', 'confirmed', 'staged', 'redo_requested', 'completed', 'deemed_completed', 'closed_unmerged', 'stale', 'cited_closed'];
    it(`sends no merge request for ${others.join(', ')}`, async () => {
      for (const status of others) {
        const id = `mo-status-${status}`;
        await addJob(id, status);
        scriptPr(id, 'merged');
        const page = await renderPage(baseUrl, `/jobs/${id}`, sessions.buyer);
        try {
          expect(page.errors, status).toEqual([]);
          // The page drew this status before the count means anything.
          expect(page.document.getElementById('claim')?.hasAttribute('data-pending'), status).toBe(false);
          expect(mergeRequests(page), status).toEqual([]);
          expect(readsOf(id), status).toBe(0);
        } finally {
          page.close();
        }
      }
    }, TIMEOUT_MS * 2);
  });

  describe('(e) a signed-in stranger on the job page', () => {
    it('sends one request, the route refuses it before reading GitHub, and nothing on screen changes', async () => {
      const id = 'mo-stranger';
      await addJob(id);
      scriptPr(id, 'merged');
      const baseline = await renderPage(baseUrl, `/jobs/${id}`, sessions.stranger, true);
      const page = await renderPage(baseUrl, `/jobs/${id}`, sessions.stranger);
      try {
        expect(baseline.errors).toEqual([]);
        expect(page.errors).toEqual([]);
        expect(mergeRequests(page)).toEqual([`POST /jobs/${id}/merge`]);
        expect(page.mergeStatuses).toEqual([403]);
        expect(readsOf(id)).toBe(0);
        expect((await readJob(id)).status).toBe('submitted');
        expect(visibleMain(page.document)).toBe(visibleMain(baseline.document));
      } finally {
        baseline.close();
        page.close();
      }
    }, TIMEOUT_MS);
  });

  describe('(f) GitHub down: the route answers 503', () => {
    it('sends one request and nothing on screen changes', async () => {
      const id = 'mo-github-down';
      // Never scripted: the fake rejects the read, as an unreachable GitHub would.
      await addJob(id);
      const baseline = await renderPage(baseUrl, `/jobs/${id}`, sessions.buyer, true);
      const page = await renderPage(baseUrl, `/jobs/${id}`, sessions.buyer);
      try {
        expect(baseline.errors).toEqual([]);
        expect(page.errors).toEqual([]);
        expect(mergeRequests(page)).toEqual([`POST /jobs/${id}/merge`]);
        expect(page.mergeStatuses).toEqual([503]);
        expect((await readJob(id)).status).toBe('submitted');
        expect(visibleMain(page.document)).toBe(visibleMain(baseline.document));
      } finally {
        baseline.close();
        page.close();
      }
    }, TIMEOUT_MS);
  });

  describe('no control asks for a merge (Make 3)', () => {
    it('no button, link or label on any of the three pages says merge, check, refresh or sync', async () => {
      const id = 'mo-no-control';
      await addJob(id);
      scriptPr(id, 'open');
      for (const [path, who] of [[`/jobs/${id}`, 'buyer'], [`/pullrequest?job=${id}`, 'buyer'], [`/operatorjob?job=${id}`, 'operator']] as const) {
        const page = await renderPage(baseUrl, path, sessions[who]);
        try {
          const controls = Array.from(page.document.querySelectorAll('main button, main a, main label, main [role="button"]'));
          expect(controls.length, path).toBeGreaterThan(0);
          for (const control of controls) {
            const words = `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''}`.toLowerCase();
            expect(words, `${path}: ${words}`).not.toMatch(/\b(merge|merged|check|refresh|sync)\b/);
          }
        } finally {
          page.close();
        }
      }
    }, TIMEOUT_MS);
  });
});
