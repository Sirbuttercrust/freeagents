// W4: the job page rebuilt from spec/wireframe/job.html. Structural gaps
// the conformance instrument cannot see on its own (it only compares
// heading text and control labels): the identity strip and its back
// control, the named heading, the track's three dot states, the diff
// line, the no-write-access paragraph, and the technical panel's criteria
// list and copy controls. Driven end to end against the real app, the
// same discipline tests/web/job.test.ts already holds to.
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
import { createJob, type Job } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential, DeemedCompletionCredential } from '../../src/adapters/credentials/types.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const BUYER_DID = 'did:example:w4-buyer';
const AGENT_DID = 'did:abt:zW4Agent';
const OPERATOR_DID = 'did:abt:zNKtD5hwiSDiwLrD6tAQRNTN1ZiDBBpaKrb';
const NO_AGENT_JOB_AGENT_DID = 'did:abt:zW4MissingAgent';

const RECENT = new Date(Date.now() - 60 * 60 * 1000);

function delegationFixture(did: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:w4-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: did },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zw4-fixture-not-verified-here',
    },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string; agentDid: string }): Job {
  const base = createJob(
    {
      id: overrides.id,
      buyerDid: BUYER_DID,
      agentDid: overrides.agentDid,
      repository: 'buyer/w4-repo',
      brief: 'Fix the checkout flow',
    },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

function credentialDoc(jobId: string, mergeCommit: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${jobId}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/w4-repo',
        pullRequest: `https://github.com/buyer/w4-repo/pull/9`,
        mergedAt: RECENT.toISOString(),
        mergeCommit,
        signedBy: `${AGENT_DID}#key-1`,
        buyer: BUYER_DID,
        additions: 186,
        deletions: 94,
        filesChanged: 9,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zw4-proof' },
  };
}

// A real DeemedCompletionCredential document (credentials.ts's own shape,
// tests/adapters/credentials/types.ts): credentialSubject.deemedCompletion,
// no `hire` object at all. Fixture for D3: the job.js:192 `hire === null`
// guard is production-reachable on exactly this shape, since GET
// /jobs/:jobId attaches the credential for deemed_completed the same way
// it does for completed (app.ts:2835).
function deemedCompletionDoc(jobId: string, stagedCommit: string): DeemedCompletionCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${jobId}`,
    type: ['VerifiableCredential', 'DeemedCompletionCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: AGENT_DID,
      deemedCompletion: {
        stagedCommit,
        noMerge: true,
        buyer: BUYER_DID,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zw4-deemed-proof' },
  };
}

let jobRepo: MemoryJobRepository;
let agentRepo: MemoryAgentRepository;
let credentialRepo: MemoryCredentialRepository;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  jobRepo = new MemoryJobRepository();
  agentRepo = new MemoryAgentRepository();
  credentialRepo = new MemoryCredentialRepository();

  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegationFixture(AGENT_DID),
    name: 'axiom-ui',
    skills: ['design-systems'],
    githubLogin: 'axiom-ui-gh',
  });

  // draft: the plain case, and the case that exercises the identity strip
  // against a real, resolvable agent read.
  await jobRepo.create(jobFixture({ id: 'w4-job-draft', agentDid: AGENT_DID }));

  // A job whose agentDid names no registered agent at all: the identity
  // read's absent branch (404), never a fault.
  await jobRepo.create(jobFixture({ id: 'w4-job-agent-absent', agentDid: NO_AGENT_JOB_AGENT_DID }));

  // submitted, no credential: the track's pull-request row without a
  // diff line, and the .done (never .merged) dot on that row.
  await jobRepo.create(
    jobFixture({
      id: 'w4-job-submitted',
      agentDid: AGENT_DID,
      status: 'submitted',
      confirmedAt: RECENT,
      confirmedSpecHash: 'sha256:confirmed-spec',
      criteria: [{ text: 'It works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
      submittedAt: RECENT,
    }),
  );

  // completed, WITH a stored credential: the merged row carries .merged,
  // the diff line renders from the credential's own numbers, and the
  // technical panel's criteria list has something to render.
  const completedJob = jobFixture({
    id: 'w4-job-completed',
    agentDid: AGENT_DID,
    status: 'completed',
    confirmedAt: RECENT,
    confirmedSpecHash: 'sha256:confirmed-spec-completed',
    criteria: [
      { text: 'All tests pass', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
      { text: 'No lint errors', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
    ],
    pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
    submittedAt: RECENT,
    mergeCommit: 'w4cafefeed',
    mergedAt: RECENT,
  });
  await jobRepo.create(completedJob);
  await credentialRepo.save({
    completedJobId: 'w4-job-completed',
    subjectDid: AGENT_DID,
    document: credentialDoc('w4-job-completed', 'w4cafefeed'),
    repositoryPublic: true,
  });

  // completed, with NO stored credential (an edge the merge route can
  // in principle leave, per app.ts's own null-credential branch): the
  // diff line must stay absent rather than reading zero or the
  // attestation's numbers.
  await jobRepo.create(
    jobFixture({
      id: 'w4-job-completed-no-credential',
      agentDid: AGENT_DID,
      status: 'completed',
      confirmedAt: RECENT,
      pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
      submittedAt: RECENT,
      mergeCommit: 'w4nocred',
      mergedAt: RECENT,
    }),
  );

  // cited_closed: the stopped dot on a non-merge close.
  await jobRepo.create(
    jobFixture({
      id: 'w4-job-cited-closed',
      agentDid: AGENT_DID,
      status: 'cited_closed',
      confirmedAt: RECENT,
      criteria: [{ text: 'It works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
      submittedAt: RECENT,
      citedCloseCriterionIndex: 0,
      citedCloseReasonText: 'The checkout flow is not actually fixed.',
      citedCloseAuthorDid: BUYER_DID,
      citedCloseAt: RECENT,
    }),
  );

  // closed_unmerged: the OTHER stopped case, a close with no buyer
  // citation attached.
  await jobRepo.create(
    jobFixture({
      id: 'w4-job-closed-unmerged',
      agentDid: AGENT_DID,
      status: 'closed_unmerged',
      confirmedAt: RECENT,
      pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
      submittedAt: RECENT,
    }),
  );

  // deemed_completed, WITH a real deemed-completion credential: D3, the
  // `hire === null` guard's production-reachable branch. GET
  // /jobs/:jobId attaches this credential for deemed_completed the same
  // way it does for completed (app.ts:2835), and a deemed-completion
  // credential carries credentialSubject.deemedCompletion with no `hire`
  // object at all. The diff line and the "Diff counts" row must both
  // stay absent, and no "+0 / -0" reaches the DOM: a zero here reads as
  // a fact about the work.
  await jobRepo.create(
    jobFixture({
      id: 'w4-job-deemed',
      agentDid: AGENT_DID,
      status: 'deemed_completed',
      confirmedAt: RECENT,
      pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
      submittedAt: RECENT,
      stagedCommit: 'w4stagedcommit',
      stagedAt: RECENT,
    }),
  );
  await credentialRepo.save({
    completedJobId: 'w4-job-deemed',
    subjectDid: AGENT_DID,
    document: deemedCompletionDoc('w4-job-deemed', 'w4stagedcommit'),
    repositoryPublic: false,
  });

  server = createApp(undefined, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo).listen(
    0,
    '127.0.0.1',
  );
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);

  return { document: dom.window.document, close: () => dom.window.close() };
}

describe('the heading carries the job\'s own real id, never a sample one', () => {
  it('renders "Job w4-job-draft", not the wireframe\'s sample id', async () => {
    const page = await render('/jobs/w4-job-draft');
    try {
      const heading = page.document.querySelector('h1');
      expect(heading).not.toBeNull();
      expect(heading!.textContent ?? '').toContain('w4-job-draft');
      expect(heading!.textContent ?? '').not.toContain('fa-7k29');
    } finally {
      page.close();
    }
  });
});

describe('the identity strip reads the agent record and links back to its profile', () => {
  it('renders the agent name and a back-to-profile control pointing at /agents/<did>', async () => {
    const page = await render('/jobs/w4-job-draft');
    try {
      const name = page.document.getElementById('who-agent-name')?.textContent ?? '';
      expect(name).toBe('axiom-ui');

      const back = Array.from(page.document.querySelectorAll('a')).find(
        (a) => (a.textContent ?? '').trim() === 'Back to profile',
      );
      expect(back).toBeDefined();
      expect(back!.getAttribute('href')).toBe(`/agents/${encodeURIComponent(AGENT_DID)}`);
    } finally {
      page.close();
    }
  });

  it('degrades to the shortened DID, with no avatar and no crash, when the agent read 404s', async () => {
    const page = await render('/jobs/w4-job-agent-absent');
    try {
      const name = page.document.getElementById('who-agent-name')?.textContent ?? '';
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toBe('axiom-ui');
      // A failed secondary read never blanks the primary record: the
      // heading and claim still render.
      const heading = page.document.querySelector('h1');
      expect(heading!.textContent ?? '').toContain('w4-job-agent-absent');
    } finally {
      page.close();
    }
  });
});

describe('the track carries three dot states, never one', () => {
  it('a merged job carries the merged class on its merge row, and done on the rest', async () => {
    const page = await render('/jobs/w4-job-completed');
    try {
      const history = page.document.getElementById('history');
      const rows = Array.from(history!.querySelectorAll('li'));
      expect(rows.length).toBeGreaterThan(0);
      const mergedRows = rows.filter((row) => row.classList.contains('merged'));
      expect(mergedRows.length).toBe(1);
      expect((mergedRows[0]!.textContent ?? '').toLowerCase()).toContain('merged');
      const nonMergedRows = rows.filter((row) => !row.classList.contains('merged'));
      nonMergedRows.forEach((row) => {
        expect(row.classList.contains('done') || row.classList.contains('stopped')).toBe(true);
      });
    } finally {
      page.close();
    }
  });

  it('a cited-closed job carries the stopped class on its close row, never merged', async () => {
    const page = await render('/jobs/w4-job-cited-closed');
    try {
      const history = page.document.getElementById('history');
      const rows = Array.from(history!.querySelectorAll('li'));
      const mergedRows = rows.filter((row) => row.classList.contains('merged'));
      expect(mergedRows.length).toBe(0);
      const stoppedRows = rows.filter((row) => row.classList.contains('stopped'));
      expect(stoppedRows.length).toBe(1);
    } finally {
      page.close();
    }
  });

  it('a closed_unmerged job also carries the stopped class', async () => {
    const page = await render('/jobs/w4-job-closed-unmerged');
    try {
      const history = page.document.getElementById('history');
      const rows = Array.from(history!.querySelectorAll('li'));
      const stoppedRows = rows.filter((row) => row.classList.contains('stopped'));
      expect(stoppedRows.length).toBe(1);
    } finally {
      page.close();
    }
  });
});

describe('the diff line renders only from the credential, never computed or defaulted', () => {
  it('is absent on a submitted job with no credential', async () => {
    const page = await render('/jobs/w4-job-submitted');
    try {
      const history = page.document.getElementById('history');
      expect((history!.textContent ?? '')).not.toMatch(/[+-]\d+ \/ [+-]?\d+/);
    } finally {
      page.close();
    }
  });

  it('renders the credential\'s real diff numbers on a completed job that has one', async () => {
    const page = await render('/jobs/w4-job-completed');
    try {
      const history = page.document.getElementById('history');
      const text = history!.textContent ?? '';
      expect(text).toContain('+186');
      expect(text).toContain('-94');
      expect(text).toContain('9 files');
    } finally {
      page.close();
    }
  });

  it('is absent on a completed job whose credential was never issued', async () => {
    const page = await render('/jobs/w4-job-completed-no-credential');
    try {
      const history = page.document.getElementById('history');
      expect((history!.textContent ?? '')).not.toMatch(/\+\d+ \/ -\d+/);
    } finally {
      page.close();
    }
  });

  // D3 (qa round 1): the `hire === null` guard at job.js:192 is
  // production-reachable, not theoretical. A deemed-completed job's
  // credential carries credentialSubject.deemedCompletion and no `hire`
  // at all, so a guard that read credential-present as "diff data
  // present" would render "+0 / -0, 0 files" here, which is exactly the
  // false claim the brief forbids: "a zero here reads as a fact about
  // the work". Removing the hire === null check (returning zeros
  // instead of null) must redden this test.
  it('is absent on a deemed-completed job whose credential has no hire object, never a claimed zero', async () => {
    const page = await render('/jobs/w4-job-deemed');
    try {
      const history = page.document.getElementById('history');
      expect((history!.textContent ?? '')).not.toMatch(/[+-]\d+ \/ [+-]?\d+/);
      expect((history!.textContent ?? '')).not.toContain('+0');

      const techDiffWrap = page.document.getElementById('tech-diff-wrap');
      expect(techDiffWrap?.hidden).toBe(true);

      const body = page.document.body.textContent ?? '';
      expect(body).not.toMatch(/\+0 \/ -0/);
    } finally {
      page.close();
    }
  });
});

describe('the accessline states the true mechanism, never the wireframe\'s fork story', () => {
  it('names the staging repository and never claims FreeAgents had write access', async () => {
    const page = await render('/jobs/w4-job-completed');
    try {
      const body = page.document.body.textContent ?? '';
      expect(body).toContain('never had');
      expect(body.toLowerCase()).not.toContain('forked the repository');
      expect(body).toContain('staging repository');
    } finally {
      page.close();
    }
  });
});

describe('the technical panel carries the criteria list and both copy controls', () => {
  it('lists every confirmed criterion, in order, as content', async () => {
    const page = await render('/jobs/w4-job-completed');
    try {
      const tech = page.document.getElementById('tech');
      expect(tech).not.toBeNull();
      const text = tech!.textContent ?? '';
      expect(text).toContain('All tests pass');
      expect(text).toContain('No lint errors');
    } finally {
      page.close();
    }
  });

  it('wires a copy control to the job id and one to the agreement fingerprint', async () => {
    const page = await render('/jobs/w4-job-completed');
    try {
      const copyButtons = Array.from(page.document.querySelectorAll('button[data-copy]'));
      const jobIdCopy = copyButtons.find((b) => b.getAttribute('data-copy') === 'w4-job-completed');
      expect(jobIdCopy).toBeDefined();
      const specHashCopy = copyButtons.find((b) => b.getAttribute('data-copy') === 'sha256:confirmed-spec-completed');
      expect(specHashCopy).toBeDefined();
    } finally {
      page.close();
    }
  });

  it('the disclosure control says "Show technical details", matching every other page', async () => {
    const page = await render('/jobs/w4-job-draft');
    try {
      const disclose = page.document.querySelector('[data-disclose]');
      expect(disclose).not.toBeNull();
      expect((disclose!.textContent ?? '').trim()).toBe('Show technical details');
      expect(disclose!.getAttribute('data-disclose-alt')).toBe('Hide technical details');
    } finally {
      page.close();
    }
  });
});

describe('the pull request opens on GitHub directly, a control distinct from the internal CTA', () => {
  it('renders "Open the pull request on GitHub" once a pull request exists, linking straight to it', async () => {
    const page = await render('/jobs/w4-job-completed');
    try {
      const link = Array.from(page.document.querySelectorAll('a')).find(
        (a) => (a.textContent ?? '').trim() === 'Open the pull request on GitHub',
      );
      expect(link).toBeDefined();
      expect(link!.getAttribute('href')).toBe('https://github.com/buyer/w4-repo/pull/9');
    } finally {
      page.close();
    }
  });

  it('is absent on a draft job with no pull request at all', async () => {
    const page = await render('/jobs/w4-job-draft');
    try {
      const section = page.document.getElementById('pullrequest-open-section');
      expect(section).not.toBeNull();
      expect(section!.hidden).toBe(true);
    } finally {
      page.close();
    }
  });
});

// D1 mobile-horizontal-overflow (qa round 1): the .who identity strip
// overflowed 6px at 320px whenever the agent read succeeds and returns an
// operatorDid, because the flex middle child's default min-width:auto let
// the nowrap operator DID floor it wider than the strip had room for. jsdom
// performs no layout, so only a real browser can catch this; the same
// RealBrowser driver tests/web/browse.test.ts already uses for exactly this
// class of defect.
describe('the identity strip does not overflow a 320px viewport (mobile-horizontal-overflow)', () => {
  it('scrollWidth equals clientWidth at 320px with a long operator DID present', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${baseUrl}/jobs/w4-job-completed`);
      const metrics = await browser.evaluate<{ clientWidth: number; scrollWidth: number; scrollXAfter: number }>(`
        (function () {
          document.getElementById('tech') && document.querySelector('[data-disclose="tech"]').click();
          window.scrollTo(999, 0);
          return {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            scrollXAfter: window.scrollX,
          };
        })()
      `);
      expect(metrics.scrollWidth, `scrollWidth ${metrics.scrollWidth} vs clientWidth ${metrics.clientWidth}`).toBe(
        metrics.clientWidth,
      );
      expect(metrics.scrollXAfter).toBe(0);
    } finally {
      await browser.close();
    }
  });
});

// D2 tap-target-under-44px (qa round 1): #who-operator-link and the
// track's "Pull request opened" anchor are plain inline anchors with no
// padding of their own, neither selector in base.css's inline-link
// padding list. Page-local fix only (base.css stays untouched, per the
// brief).
describe('every rendered interactive control on the job page is at least 44px at 320px (tap-target-under-44px)', () => {
  it('the operator link and the pull-request track anchor both meet the 44px floor', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    try {
      await browser.goto(`${baseUrl}/jobs/w4-job-completed`);
      await browser.evaluate(`document.querySelector('[data-disclose="tech"]').click()`);

      const undersized = await browser.evaluate<Array<[string, number, number]>>(`
        Array.from(document.querySelectorAll('button, a'))
          .filter((el) => el.offsetParent !== null && el.closest('[hidden]') === null)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [el.id || el.className || (el.textContent || '').trim(), r.width, r.height];
          })
          .filter(([, w, h]) => w < 44 || h < 44)
      `);
      expect(undersized, `undersized targets: ${JSON.stringify(undersized)}`).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

// layout-broken-at-desktop (three strikes on the standing ledger): the
// 760px tap-target media query above must not leak past its own
// breakpoint and the page must stay clean at 1280px, the same check the
// qa round 1 review already ran by hand.
describe('the job page stays clean at 1280px desktop (layout-broken-at-desktop)', () => {
  it('no horizontal overflow at 1280px', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.goto(`${baseUrl}/jobs/w4-job-completed`);
      const metrics = await browser.evaluate<{ clientWidth: number; scrollWidth: number; scrollXAfter: number }>(`
        (function () {
          document.querySelector('[data-disclose="tech"]').click();
          window.scrollTo(9999, 0);
          return {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            scrollXAfter: window.scrollX,
          };
        })()
      `);
      expect(metrics.scrollWidth).toBe(metrics.clientWidth);
      expect(metrics.scrollXAfter).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
