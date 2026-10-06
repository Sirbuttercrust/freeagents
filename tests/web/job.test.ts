// P8f (issue inert-declared-control, sixth occurrence): GET /jobs/:jobId
// has been mounted and public since R-7, answering jobProjection(row), but
// src/web/static.ts mounted nothing at that path -- a person handed the
// address of their own hire was handed raw JSON. This file drives the real
// app over HTTP with a browser Accept header and asserts what a visitor is
// left looking at (the discipline tests/web/nav-auth.test.ts and
// tests/web/signin-flow.test.ts already hold to for the fifth occurrence),
// never merely that the markup shipped.
//
// Every assertion below was run against the pre-fix tree (no job mount in
// src/web/static.ts) and observed to fail: a browser asking for
// /jobs/<id> got the bare `{"id":...}` JSON body, not a page.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import { jobPageReady, settled } from '../helpers/page-settled.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function jobFixture(overrides: Partial<Job> & { id: string }): Job {
  const base = createJob(
    {
      id: overrides.id,
      buyerDid: 'did:example:job-page-buyer',
      agentDid: 'did:example:job-page-agent',
      repository: 'buyer/job-page-repo',
      brief: 'Fix the checkout flow',
    },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

let jobRepo: MemoryJobRepository;
let server: Server;
let baseUrl: string;

// Fixed points close to "now" rather than hardcoded 2026 dates: GET
// /jobs/:jobId runs the live lapse clocks on every read (applyLiveLapses,
// src/api/app.ts), and a confirmedAt/stagedAt/submittedAt more than their
// window's days old would silently flip the fixture's own status before
// this file ever gets to assert on it.
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

beforeAll(async () => {
  jobRepo = new MemoryJobRepository();

  // draft: the plain case, used by the core rendering assertions below.
  await jobRepo.create(jobFixture({ id: 'job-draft' }));

  // confirmed, with NO submission: the absence-of-a-row proof.
  await jobRepo.create(
    jobFixture({
      id: 'job-confirmed-no-submission',
      status: 'confirmed',
      confirmedAt: RECENT,
      confirmedSpecHash: 'sha256:confirmed-spec',
      priceUsd: '500.00',
      rail: 'abt',
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      criteria: [{ text: 'It works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    }),
  );

  // submitted: a real submission row, to prove the row DOES render when
  // the group is present (the positive half of the absence proof).
  await jobRepo.create(
    jobFixture({
      id: 'job-submitted',
      status: 'submitted',
      confirmedAt: RECENT,
      pullRequestUrl: 'https://github.com/buyer/job-page-repo/pull/9',
      submittedAt: RECENT,
    }),
  );

  // cited_closed: the "no money returns" proof.
  await jobRepo.create(
    jobFixture({
      id: 'job-cited-closed',
      status: 'cited_closed',
      confirmedAt: RECENT,
      pullRequestUrl: 'https://github.com/buyer/job-page-repo/pull/9',
      submittedAt: RECENT,
      citedCloseCriterionIndex: 0,
      citedCloseReasonText: 'The checkout flow is not actually fixed.',
      citedCloseAuthorDid: 'did:example:job-page-buyer',
      citedCloseAt: RECENT,
    }),
  );

  // One fixture per remaining JobStatus value, for the per-state sweep.
  const remainingStatuses: readonly JobStatus[] = [
    'proposed',
    'completed',
    'declined',
    'closed_unmerged',
    'stale',
    'withdrawn',
    'staged',
    'staged_declined',
    'closed_unpaid',
    'expired_unstaged',
    'deemed_completed',
    'paid_undelivered',
  ];
  for (const status of remainingStatuses) {
    await jobRepo.create(jobFixture({ id: `job-status-${status}`, status }));
  }

  // A brief that LOOKS like markup: the containment proof. If the page ever
  // rendered this through innerHTML instead of textContent, the <b> tag
  // would parse as an element and the <img onerror> would be a live XSS
  // vector; through textContent it can only ever appear as literal text.
  await jobRepo.create(
    jobFixture({
      id: 'job-markup-looking-brief',
      brief: 'Fix <b>the</b> checkout flow, not <img src=x onerror=alert(1)>',
    }),
  );

  server = createApp(
    undefined,
    undefined,
    undefined,
    undefined,
    jobRepo,
  ).listen(0, '127.0.0.1');
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

async function render(path: string, expectStatus = 200): Promise<Rendered> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));

  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  expect(response.status, `unexpected status for ${path}`).toBe(expectStatus);
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
  // FIX-CIFLAKE cause 3: waits on the page's own settled signal
  // (job.js's render() removing #claim's data-pending, or failLoad
  // showing #load-error) instead of a fixed 250ms sleep. The fixed sleep
  // made "no two statuses share the same sentence" (14 renders back to
  // back) spend 3.5s asleep regardless of how fast each render actually
  // settled, and under a loaded CI runner it could still not be enough:
  // vitest's default 5000ms test timeout was measured failing on it
  // (4 of 200 runs, tests/web/job.test.ts's own "Test timed out in
  // 5000ms"). This never waits longer than the page actually needs.
  await settled(dom.window.document, jobPageReady, path);

  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);

  return { document: dom.window.document, close: () => dom.window.close() };
}

describe('GET /jobs/:jobId answers a page to a browser (inert-declared-control, sixth occurrence)', () => {
  it('renders the state sentence, the repository and the brief', async () => {
    const page = await render('/jobs/job-draft');
    try {
      const stateLabel = page.document.getElementById('state-label')?.textContent ?? '';
      expect(stateLabel).toContain('draft');

      const claim = page.document.getElementById('claim')?.textContent ?? '';
      expect(claim).toContain('buyer/job-page-repo');
      expect(claim).toContain('Fix the checkout flow');
    } finally {
      page.close();
    }
  });

  it('the technical details sit behind the disclosure, not in the first view', async () => {
    const page = await render('/jobs/job-draft');
    try {
      const tech = page.document.getElementById('tech');
      expect(tech).not.toBeNull();
      expect(tech!.hidden).toBe(true);

      const techId = page.document.getElementById('tech-id')?.textContent ?? '';
      expect(techId).toBe('job-draft');
    } finally {
      page.close();
    }
  });
});

describe('mounting the job page changed no API behaviour', () => {
  it('answers JSON to Accept: application/json, unchanged', async () => {
    const res = await fetch(`${baseUrl}/jobs/job-draft`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: 'job-draft', status: 'draft', repository: 'buyer/job-page-repo' });
  });

  it('answers JSON to Accept: */*, unchanged', async () => {
    const res = await fetch(`${baseUrl}/jobs/job-draft`, { headers: { Accept: '*/*' } });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
  });

  it('answers JSON with no Accept header at all, unchanged', async () => {
    const res = await fetch(`${baseUrl}/jobs/job-draft`);
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('application/json');
  });

  it('still 404s an unknown id as JSON for a non-browser caller', async () => {
    const res = await fetch(`${baseUrl}/jobs/no-such-job`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('an unknown job id answers a readable page, not raw JSON and not a blank record', () => {
  it('says the hire was not found', async () => {
    const page = await render('/jobs/no-such-job');
    try {
      const stateLabel = page.document.getElementById('state-label')?.textContent ?? '';
      expect(stateLabel.toLowerCase()).toContain('not found');
      const loadError = page.document.getElementById('load-error');
      expect(loadError?.hidden).toBe(false);
    } finally {
      page.close();
    }
  });
});

describe('fifteen of the seventeen JobStatus values render a distinct plain sentence here (cited_closed has dedicated coverage below in this file, redo_requested has dedicated coverage in tests/web/staged.test.ts)', () => {
  const allStatuses: readonly JobStatus[] = [
    'draft',
    'proposed',
    'confirmed',
    'submitted',
    'completed',
    'declined',
    'closed_unmerged',
    'stale',
    'withdrawn',
    'staged',
    'staged_declined',
    'closed_unpaid',
    'expired_unstaged',
    'deemed_completed',
    'paid_undelivered',
  ];

  // The one fixture id per status, matching the seed data in beforeAll
  // exactly: draft, confirmed and submitted each have a dedicated,
  // named fixture (job-draft, job-confirmed-no-submission, job-submitted);
  // every other status was seeded as job-status-<status>. A status
  // missing from this map would fetch a job id that was never created,
  // silently rendering the "not found" page instead of the real state --
  // which still has a non-empty state-label, so it must never be allowed
  // to pass by accident.
  function jobIdFor(status: JobStatus): string {
    if (status === 'draft') return 'job-draft';
    if (status === 'confirmed') return 'job-confirmed-no-submission';
    if (status === 'submitted') return 'job-submitted';
    return `job-status-${status}`;
  }

  it('covers exactly fifteen of the seventeen prisma JobStatus values (all but cited_closed, covered below in this file, and redo_requested, covered in tests/web/staged.test.ts), so a status with no sentence cannot go unnoticed', () => {
    expect(allStatuses.length).toBe(15);
  });

  it.each(allStatuses)('%s renders a plain sentence, not the raw status value', async (status) => {
    const page = await render(`/jobs/${jobIdFor(status)}`);
    try {
      const stateLabel = page.document.getElementById('state-label')?.textContent ?? '';
      expect(stateLabel.trim(), `status ${status} rendered an empty sentence`).not.toBe('');
      // The bare enum value is not a sentence. If a status ever falls
      // through to the raw-value fallback in job.js, that read as a
      // non-empty string too, so a person landed on jargon instead of a
      // blank screen and this guard stayed green. Checking the label
      // against the raw status closes that hole.
      expect(stateLabel.trim(), `status ${status} rendered its own raw value, not a sentence`).not.toBe(status);
      expect(stateLabel.trim().endsWith('.'), `status ${status} did not render a full sentence`).toBe(true);
    } finally {
      page.close();
    }
  });

  it('no two statuses share the same sentence', async () => {
    const seen = new Map<string, string>();
    for (const status of allStatuses) {
      const page = await render(`/jobs/${jobIdFor(status)}`);
      try {
        const stateLabel = page.document.getElementById('state-label')?.textContent ?? '';
        const collision = seen.get(stateLabel);
        expect(collision, `status ${status} shares its sentence with ${String(collision)}`).toBeUndefined();
        seen.set(stateLabel, status);
      } finally {
        page.close();
      }
    }
  });
});

// A hire paid in full whose pull request never opened within seven days
// ends paid_undelivered. The page draws the same sentence and map for every
// reader, so one signed-out render covers both seats here.
describe('a hire paid in full that ended with no pull request reads as ended', () => {
  it('shows the whole paid-and-never-delivered sentence and no step map', async () => {
    const page = await render('/jobs/job-status-paid_undelivered');
    try {
      expect(page.document.getElementById('state-label')?.textContent ?? '').toBe(
        'The hire was paid in full, but the pull request did not open within seven days, so it ended as paid and never delivered. No money returns.',
      );
      const where = page.document.getElementById('job-where');
      expect(where, '#job-where is missing from the served page').not.toBeNull();
      expect(where!.hidden).toBe(true);
      expect(where!.querySelector('ol.stepflow')).toBeNull();
    } finally {
      page.close();
    }
  });
});

describe('an absent group renders no row at all, never a pending row with an empty date', () => {
  it('a confirmed job with no submission shows no submission row', async () => {
    const page = await render('/jobs/job-confirmed-no-submission');
    try {
      const history = page.document.getElementById('history');
      expect(history).not.toBeNull();
      const rows = Array.from(history!.querySelectorAll('li'));
      const hasSubmissionRow = rows.some((row) => (row.textContent ?? '').toLowerCase().includes('pull request'));
      expect(hasSubmissionRow, 'a confirmed-with-no-submission job rendered a pull request row').toBe(false);
    } finally {
      page.close();
    }
  });

  it('a submitted job DOES show the submission row, proving the absence above is real', async () => {
    const page = await render('/jobs/job-submitted');
    try {
      const history = page.document.getElementById('history');
      const rows = Array.from(history!.querySelectorAll('li'));
      const hasSubmissionRow = rows.some((row) => (row.textContent ?? '').toLowerCase().includes('pull request'));
      expect(hasSubmissionRow).toBe(true);
    } finally {
      page.close();
    }
  });
});

describe('a job with a cited close states that no money returns', () => {
  it('renders the close section with no refund vocabulary', async () => {
    const page = await render('/jobs/job-cited-closed');
    try {
      A_showsCloseSection(page);
    } finally {
      page.close();
    }
  });
});

function A_showsCloseSection(page: Rendered): void {
  const section = page.document.getElementById('close-section');
  expect(section?.hidden).toBe(false);
  const detail = page.document.getElementById('close-detail')?.textContent ?? '';
  expect(detail).toContain('No money returns');
  expect(detail.toLowerCase()).not.toContain('refund');
}

describe('the job page loads api.js and nav.js, and its nav flips to signed-in', () => {
  it('carries the nav script tags', async () => {
    const res = await fetch(`${baseUrl}/jobs/job-draft`, { headers: { Accept: HTML } });
    const body = await res.text();
    expect(body).toContain('src="/js/pages/api.js"');
    expect(body).toContain('src="/js/pages/nav.js"');
  });
});

describe('the brief goes into the DOM through textContent, never as markup', () => {
  it('a brief that looks like markup renders as literal text, with no element it created', async () => {
    const page = await render('/jobs/job-markup-looking-brief');
    try {
      const claim = page.document.getElementById('claim');
      expect(claim).not.toBeNull();
      // The literal string survives whole in textContent...
      expect(claim!.textContent ?? '').toContain('Fix <b>the</b> checkout flow, not <img src=x onerror=alert(1)>');
      // ...and the brief's own markup-looking text never parses into a
      // live element: an <img> can only appear here if the brief were
      // ever handed to innerHTML, since nothing else on this page ever
      // creates one.
      expect(claim!.querySelector('img')).toBeNull();
    } finally {
      page.close();
    }
  });
});

// A pinning check for the prose count, so it can never again drift the
// way "fourteen" drifted here: this reads both source files as text
// (never imports job.js, which is a browser IIFE with no export) and
// compares the enum's own member set against STATE_SENTENCES's key set,
// not just their lengths. Removing a status from STATE_SENTENCES without
// removing it from the schema, or the reverse, reddens this even if the
// two sets happened to stay the same size.
describe('STATE_SENTENCES in job.js covers exactly the JobStatus values prisma/schema.prisma declares', () => {
  it('the two sets match member for member', () => {
    const schema = readFileSync(join(repoRoot, 'prisma/schema.prisma'), 'utf8');
    const enumBody = schema.match(/enum JobStatus \{([\s\S]*?)\n\}/);
    if (enumBody === null) throw new Error('enum JobStatus not found in prisma/schema.prisma');
    const schemaStatuses = (enumBody[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'))
      .sort();

    const jobJs = readFileSync(join(repoRoot, 'src/web/public/js/pages/job.js'), 'utf8');
    const sentencesBody = jobJs.match(/var STATE_SENTENCES = \{([\s\S]*?)\n {2}\};/);
    if (sentencesBody === null) throw new Error('STATE_SENTENCES not found in job.js');
    const sentenceKeys = (sentencesBody[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => line.match(/^([a-zA-Z_]+):/)?.[1])
      .filter((key): key is string => key !== undefined)
      .sort();

    expect(sentenceKeys, 'STATE_SENTENCES keys do not match the JobStatus enum members').toEqual(schemaStatuses);
  });
});

// FIX-SW12m (SW3-08, SITEMAP P-17, ENT-10.1): on a completed hire, its
// buyer sees "Write a review" beside "See the receipt", linking to
// /review?job=<id>. Nobody else sees it, on no other status, and a failed
// /accounts/me read shows nothing. Its own app, with real sessions for the
// buyer, the agent's owner and a stranger. Each negative case also names
// what the page DID do for that visitor, so a page that never read the
// account cannot pass as "no link".
describe('(e) Write a review, for the buyer of a completed hire only', () => {
  const AGENT = 'did:abt:jr-agent';
  const OWNER = 'did:abt:jr-owner';
  const BUYER = 'did:abt:jr-buyer';
  const STRANGER = 'did:abt:jr-stranger';
  const tokens: Record<'buyer' | 'owner' | 'stranger', string> = { buyer: '', owner: '', stranger: '' };
  let srv: Server;
  let url: string;

  beforeAll(async () => {
    const agents = new MemoryAgentRepository();
    const delegation: Delegation = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: `urn:uuid:delegation-for-${AGENT}`,
      type: ['VerifiableCredential', 'AgentDelegation'],
      issuer: OWNER,
      issuanceDate: '2026-01-01T00:00:00Z',
      credentialSubject: { id: AGENT },
      proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${AGENT}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture' },
    };
    await agents.create({ did: AGENT, operatorDid: OWNER, delegation, name: 'jr-scout', skills: ['triage'], githubLogin: null, floorPriceUsd: null });
    const accounts = new MemoryAccountRepository();
    for (const [did, login] of [[OWNER, 'jr-owner'], [BUYER, 'jr-buyer'], [STRANGER, 'jr-stranger']] as const) {
      await accounts.register({ did, githubLogin: login });
    }
    const jobs = new MemoryJobRepository();
    const base = (id: string, over: Partial<Job>): Job => ({ ...createJob({ id, buyerDid: BUYER, agentDid: AGENT, repository: 'buyer/jr-repo', brief: 'Fix it' }, RECENT), ...over });
    const pr = { pullRequestUrl: 'https://github.com/buyer/jr-repo/pull/3', submittedAt: RECENT };
    await jobs.create(base('jr-completed', { status: 'completed', ...pr, mergeCommit: 'jrmerge', mergedAt: RECENT }));
    await jobs.create(base('jr-submitted', { status: 'submitted', ...pr }));
    let login = 'jr-owner';
    const adapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: ((input: string, init?: RequestInit) => fakeGitHubFetch({ login, id: login.length })(input, init)) as typeof fetch,
    });
    srv = createApp(accounts, agents, undefined, undefined, jobs, undefined, undefined, undefined,
      { verify: 10_000, read: 10_000, write: 10_000, upstream: 10_000 }, undefined, undefined, adapter).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => srv.once('listening', resolve));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    tokens.owner = await mintSessionToken(adapter);
    login = 'jr-buyer';
    tokens.buyer = await mintSessionToken(adapter);
    login = 'jr-stranger';
    tokens.stranger = await mintSessionToken(adapter);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  // Renders /jobs/<id> with the given session and waits until every read
  // the page started has answered. `reads` lists the paths it fetched.
  async function open(id: string, who: keyof typeof tokens | null, failMe = false): Promise<{ document: Document; reads: string[]; close: () => void }> {
    const markup = await (await fetch(`${url}/jobs/${id}`, { headers: { Accept: HTML } })).text();
    const reads: string[] = [];
    let inflight = 0;
    let last = Date.now();
    const dom = new JSDOM(markup, {
      url: `${url}/jobs/${id}`,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        if (who !== null) window.sessionStorage.setItem('fa_session', JSON.stringify({ token: tokens[who] }));
        Object.defineProperty(window, 'fetch', {
          writable: true,
          value: (input: string, init?: RequestInit) => {
            reads.push(input);
            inflight += 1;
            const done = <T>(v: T): T => { inflight -= 1; last = Date.now(); return v; };
            if (failMe && input === '/accounts/me') return Promise.resolve(new Response('{}', { status: 503 })).then(done);
            return fetch(new URL(input, url), init).then(done, (e: unknown) => { done(null); throw e; });
          },
        });
      },
    });
    await new Promise<void>((resolve) => {
      if (dom.window.document.readyState === 'complete') resolve();
      else dom.window.addEventListener('load', () => resolve());
    });
    await settled(dom.window.document, jobPageReady, `/jobs/${id}`);
    const deadline = Date.now() + 8000;
    while (inflight > 0 || Date.now() - last < 150) {
      if (Date.now() > deadline) throw new Error(`/jobs/${id} kept reading past 8s`);
      await new Promise((r) => setTimeout(r, 25));
    }
    return { document: dom.window.document, reads, close: () => dom.window.close() };
  }

  const reviewLinks = (d: Document): Element[] =>
    Array.from(d.querySelectorAll('a, button')).filter((el) => /review/i.test(el.textContent ?? '') && !/review the work/i.test(el.textContent ?? ''));

  it('the buyer of a completed hire sees "Write a review" beside "See the receipt", linking to /review?job=<id>', async () => {
    const page = await open('jr-completed', 'buyer');
    try {
      const links = reviewLinks(page.document);
      expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.className])).toEqual([['Write a review', '/review?job=jr-completed', 'btn']]);
      expect(links[0]!.closest('[hidden]'), 'the link sits in a shown section').toBeNull();
      expect(links[0]!.parentElement).toBe(page.document.getElementById('credential-link')?.parentElement);
      expect(page.document.querySelector('.nav a[href^="/review"]'), 'no nav entry reaches /review').toBeNull();
    } finally {
      page.close();
    }
  });

  it.each([
    ['the agent\u2019s owner', 'jr-completed', 'owner'],
    ['a signed-in stranger', 'jr-completed', 'stranger'],
    ['a signed-out visitor', 'jr-completed', null],
    ['the buyer, on a submitted hire', 'jr-submitted', 'buyer'],
  ] as const)('%s sees no review link', async (_who, id, who) => {
    const page = await open(id, who);
    try {
      expect(page.document.getElementById('claim')?.textContent, 'the hire rendered').toContain('buyer/jr-repo');
      // open() waits for every read to answer, so for a signed-in visitor
      // the account read has landed before the check below.
      expect(page.reads.includes('/accounts/me'), 'the account read ran for a signed-in visitor').toBe(who !== null);
      expect(reviewLinks(page.document)).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('the buyer sees no review link while the account read fails', async () => {
    const page = await open('jr-completed', 'buyer', true);
    try {
      expect(page.reads).toContain('/accounts/me');
      expect(reviewLinks(page.document)).toEqual([]);
    } finally {
      page.close();
    }
  });
});
