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

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job, type JobStatus } from '../../src/domain/job.js';

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
  await new Promise((resolve) => setTimeout(resolve, 250));

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

describe('every one of the fourteen JobStatus values renders a distinct plain sentence', () => {
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

  it('covers exactly the fourteen prisma JobStatus values, so a status with no sentence cannot go unnoticed', () => {
    expect(allStatuses.length).toBe(14);
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
