// S1: the hire journey, simple. Five pages a buyer walks through to hire
// (the brief, the deposit, the job, the staged work, the pull request),
// rewritten to the landing page's level of simple. What that promises is
// pinned here as rules rather than as copy:
//
//   a word ceiling      each page ships at most 40% of the words it shipped
//                       before S1, and never more than 120, counted by the
//                       same rule as the card's static_words.py (the text
//                       inside <main>, scripts, styles, templates and
//                       comments removed). One test per page.
//   where you are       every page carries the landing page's five-step
//                       diagram, small, with the right step lit, drawn from
//                       the one list in stepflow.js; the job page lights the
//                       step from the hire's own status
//   one primary action  at most one primary button is reachable in any
//                       state a page renders, dialogs closed
//   no jargon           none of the card's machine words sits on the
//                       surface; they may sit behind "Show technical
//                       details", which is where DESIGN.md 1.3 puts them
//   the detail moved    every link that replaced a paragraph names what is
//                       behind it and lands on something that exists
//   the money is exact  every amount on the deposit, staged and pull
//                       request pages equals what src/domain/payment.ts
//                       computes for the same price
//   laid out right      at 1280 and 320: no sideways scroll, every control
//                       44px or more, disclosures opened and sheets open,
//                       the map finished and still under reduced motion
//
// The other tests that guard these pages (hire-flow, hire-polished,
// deposit, job, job-wireframe, staged, pullrequest, pullrequest-polished,
// mobile-layout, wireframe-conformance) still run against them.
//
// Set S1_CAPTURE_DIR to a directory to have the layout sweep also save a
// full-page screenshot of every page at both widths. Off by default.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryAttestationRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { buildAttestation, type StagingObservation } from '../../src/domain/attestation.js';
import { createJob, type Job } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import { ABT_FEE_RATE_PERCENT, USDC_FEE_RATE_PERCENT, calculateFee, depositUsd, remainderUsd } from '../../src/domain/payment.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { unsettledGate } from '../helpers/settlement-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const BROWSER_TIMEOUT_MS = 60_000;

// ------------------------------------------------------------ the ceilings

// The count each page shipped before S1 (origin/main at b964585), measured
// by the card's static_words.py. job.html had no <main> then, so its count
// was the whole file's; it has one now, which is what the count below reads.
const BEFORE: Record<string, number> = { hire: 403, deposit: 298, job: 146, staged: 283, pullrequest: 237 };
const HARD_CEILING = 120;
const ceiling = (page: string): number => Math.min(HARD_CEILING, Math.floor((BEFORE[page] ?? 0) * 0.4));

// static_words.py, ported line for line: <main> to </main>, then script,
// style and template blocks out, then comments out, then tags to spaces,
// then entities decoded, then split on whitespace. The one difference from
// a DOM text walk is deliberate: this counts hidden state panels too,
// because they are copy the page ships and a person meets in some state.
function staticWords(src: string): string[] {
  const m = src.match(/<main[\s\S]*?<\/main>/);
  let body = m ? m[0] : src;
  body = body.replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  const text = body.replace(/<[^>]+>/g, ' ');
  const decoded = new JSDOM(`<p>${text.replace(/</g, '&lt;')}</p>`).window.document.body.textContent ?? '';
  return decoded.split(/\s+/).filter(Boolean);
}

const pageSource = (page: string): string => readFileSync(join(repoRoot, 'src/web/pages', `${page}.html`), 'utf8');

describe('each journey page ships at most 40% of its words, and never more than 120', () => {
  it('the counter agrees with static_words.py on a known input', () => {
    // A tripwire on the port itself: a comment that quotes a tag, a script,
    // an entity and a template must all be handled the way the script does.
    const src = '<nav>Nav words</nav><main><!-- a <b>note</b> --><h1>One&nbsp;two</h1><script>var x = "no";</script><template><p>no</p></template><p>three &amp; four</p></main>';
    expect(staticWords(src)).toEqual(['One', 'two', 'three', '&', 'four']);
  });

  it.each(Object.keys(BEFORE))('%s', (page) => {
    const src = pageSource(page);
    expect(src.match(/<main\b/g)?.length, `${page} must have exactly one <main>, or the count reads the whole file`).toBe(1);
    const words = staticWords(src);
    expect(words.length, `${page}: ${words.length} words, ceiling ${ceiling(page)}. The copy: ${words.join(' ')}`).toBeLessThanOrEqual(
      ceiling(page),
    );
  });
});

// ---------------------------------------------------------- the one step list

describe('the five steps are one list, and it is the landing page\u2019s', () => {
  it('stepflow.js HIRE_STEPS carries the landing diagram\u2019s five labels, in order', () => {
    const landing = new JSDOM(pageSource('landing')).window.document;
    const landingLabels = Array.from(landing.querySelectorAll('#how .sf-label')).map((el) => (el.textContent ?? '').trim());
    expect(landingLabels).toHaveLength(5);

    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(readFileSync(join(repoRoot, 'src/web/public/js/stepflow.js'), 'utf8'));
    const steps = (dom.window as unknown as { FAStepflow: { HIRE_STEPS: Array<{ label: string }> } }).FAStepflow.HIRE_STEPS;
    expect(steps.map((s) => s.label)).toEqual(landingLabels);
  });

  it('job.js maps every JobStatus to a step or to no map, and nothing else', () => {
    const schema = readFileSync(join(repoRoot, 'prisma/schema.prisma'), 'utf8');
    const statuses = (schema.match(/enum JobStatus \{([\s\S]*?)\n\}/)?.[1] ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'))
      .sort();
    expect(statuses.length, 'no JobStatus enum parsed: the derivation broke, not the page').toBeGreaterThan(10);

    const jobJs = readFileSync(join(repoRoot, 'src/web/public/js/pages/job.js'), 'utf8');
    const body = jobJs.match(/var STEP_FOR_STATUS = \{([\s\S]*?)\n {2}\};/)?.[1] ?? '';
    const map = Object.fromEntries([...body.matchAll(/([a-z_]+):\s*("done"|null|\d)/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(map).sort()).toEqual(statuses);
    // The five steps are the only values a status may take: a number 1 to 5,
    // "done", or null for a hire that ended before it finished.
    for (const [status, value] of Object.entries(map)) {
      expect(['1', '2', '3', '4', '5', '"done"', 'null'], `${status} maps to ${value}`).toContain(value);
    }
  });
});

// ------------------------------------------------------------ the fixtures

const AGENT_DID = 'did:abt:zS1JourneyAgent';
const OPERATOR_DID = 'did:abt:zS1JourneyOperator';
const BUYER_DID = 'did:abt:s1-journey-buyer';
const QUIET_AGENT_DID = 'did:abt:zS1QuietAgent';
const QUIET_OPERATOR_DID = 'did:abt:zS1QuietOperator';
const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const PRICE = '1200.00';

function delegation(did: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:s1-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-09-01T00:00:00Z',
    credentialSubject: { id: did },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-01T00:00:00Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zS1FixtureNotVerifiedHere',
    },
  };
}

const CRITERIA = [
  { text: 'The cart survives a refresh', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true },
  { text: 'No new lint errors', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true },
];

function job(overrides: Partial<Job> & { id: string }): Job {
  const base = createJob(
    { id: overrides.id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/s1-repo', brief: 'Stop the cart emptying on refresh.' },
    new Date('2026-09-01T00:00:00Z'),
  );
  return {
    ...base,
    criteria: CRITERIA,
    priceUsd: PRICE,
    rail: 'abt',
    depositPercent: 25,
    redoAllowance: 1,
    deliveryWindowDays: 6,
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    ...overrides,
  };
}

const OBSERVATION: StagingObservation = {
  diffHash: 'sha256:s1-diff',
  filesChanged: 4,
  linesAdded: 120,
  linesRemoved: 30,
  changedPaths: ['src/cart.ts', 'src/cart.test.ts', 'src/store.ts', 'README.md'],
  lineShareByCategory: { source: 70, test: 20, lockfile: 0, generated: 0, vendored: 0 },
  testsDeleted: [],
  testsSkipAdded: [],
  outOfCriteriaPathCount: 4,
  commitSigners: [{ matchesAgentDid: true }],
};

// One job per status the journey pages render. Each page's path and the
// step its map must light, or null where the page draws no map.
interface Journey {
  readonly label: string;
  readonly page: string;
  readonly path: string;
  readonly step: number | 'done' | null;
}
const JOURNEY: ReadonlyArray<Journey> = [
  { label: 'hire', page: 'hire', path: `/hire?agent=${encodeURIComponent(AGENT_DID)}`, step: 2 },
  { label: 'deposit', page: 'deposit', path: '/deposit?job=s1-proposed', step: 2 },
  { label: 'job, draft', page: 'job', path: '/jobs/s1-draft', step: 2 },
  { label: 'job, proposed', page: 'job', path: '/jobs/s1-proposed', step: 2 },
  { label: 'job, confirmed', page: 'job', path: '/jobs/s1-confirmed', step: 3 },
  { label: 'job, staged', page: 'job', path: '/jobs/s1-staged', step: 4 },
  { label: 'job, redo requested', page: 'job', path: '/jobs/s1-redo', step: 3 },
  { label: 'job, submitted', page: 'job', path: '/jobs/s1-submitted', step: 'done' },
  { label: 'job, completed', page: 'job', path: '/jobs/s1-completed', step: 'done' },
  { label: 'job, declined', page: 'job', path: '/jobs/s1-declined', step: null },
  { label: 'staged', page: 'staged', path: '/staged?job=s1-staged', step: 4 },
  { label: 'staged, redo requested', page: 'staged', path: '/staged?job=s1-redo', step: 3 },
  { label: 'pullrequest', page: 'pullrequest', path: '/pullrequest?job=s1-submitted', step: 'done' },
];

let server: Server;
let baseUrl: string;
let buyerSession: Session;

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_DID),
    name: 's1-journey-scout',
    skills: ['frontend'],
    githubLogin: null,
  });
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: BUYER_DID, githubLogin: 's1-journey-buyer' });
  await accountRepo.register({ did: OPERATOR_DID, githubLogin: 's1-journey-operator' });
  // The fallback: an agent with no name, run by an operator whose account
  // carries no GitHub login. The page must still say who, in words.
  await agentRepo.create({
    did: QUIET_AGENT_DID,
    operatorDid: QUIET_OPERATOR_DID,
    delegation: delegation(QUIET_AGENT_DID),
    name: '',
    skills: ['frontend'],
    githubLogin: null,
  });
  await accountRepo.register({ did: QUIET_OPERATOR_DID });

  const jobRepo = new MemoryJobRepository();
  const attestationRepo = new MemoryAttestationRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const credentials = createCredentialsAdapter(undefined, credentialRepo);

  const staged = { stagedAt: RECENT, stagedCommit: 's1stagedcommit', confirmedAt: RECENT, confirmedSpecHash: 'sha256:s1-spec' };
  const fixtures: Job[] = [
    job({ id: 's1-draft', priceUsd: null, rail: null, priceAcceptedByBuyer: false, priceAcceptedByAgent: false, criteria: [] }),
    job({ id: 's1-proposed', status: 'proposed' }),
    job({ id: 's1-confirmed', status: 'confirmed', confirmedAt: RECENT, confirmedSpecHash: 'sha256:s1-spec' }),
    job({ id: 's1-staged', status: 'staged', ...staged }),
    job({ id: 's1-redo', status: 'redo_requested', ...staged, redoRequestedCriterionIndex: 0, redoRequestedAt: RECENT }),
    job({
      id: 's1-submitted',
      status: 'submitted',
      ...staged,
      pullRequestUrl: 'https://github.com/buyer/s1-repo/pull/7',
      submittedAt: RECENT,
    }),
    job({
      id: 's1-completed',
      status: 'completed',
      ...staged,
      pullRequestUrl: 'https://github.com/buyer/s1-repo/pull/7',
      submittedAt: RECENT,
      mergeCommit: 's1mergecommit',
      mergedAt: RECENT,
    }),
    job({ id: 's1-declined', status: 'declined' }),
  ];
  for (const f of fixtures) {
    await jobRepo.create(f);
    if (f.stagedAt) {
      const attestation = buildAttestation(f, OBSERVATION, RECENT);
      await attestationRepo.save({ jobId: f.id, attestation, signed: await credentials.signAttestation(attestation) });
    }
  }

  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 's1-journey-buyer', id: 9511 }),
  });
  server = createApp(
    accountRepo,
    agentRepo,
    undefined,
    undefined,
    jobRepo,
    credentials,
    undefined,
    credentialRepo,
    undefined,
    undefined,
    undefined,
    sessionAdapter,
    undefined,
    unsettledGate(),
    undefined,
    attestationRepo,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  buyerSession = await mintSession(sessionAdapter);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// The page with its own scripts run for real, signed in as the buyer.
async function render(path: string): Promise<{ document: Document; close: () => void }> {
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  expect(res.status, path).toBe(200);
  const dom = new JSDOM(await res.text(), {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.sessionStorage.setItem('fa_session', JSON.stringify(buyerSession));
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
  await new Promise((resolve) => setTimeout(resolve, 450));
  const real = failures.filter((m) => !m.includes('Not implemented'));
  if (real.length > 0) throw new Error(`page script failed on ${path}: ${real.join('; ')}`);
  return { document: dom.window.document, close: () => dom.window.close() };
}

function reachable(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if ((n as HTMLElement).hidden) return false;
    if (n.tagName === 'DIALOG' && !n.hasAttribute('open')) return false;
    if (n.classList.contains('detail')) return false;
  }
  return true;
}

// --------------------------------------------------------- where you are

describe('every journey page shows the five steps with the right one lit', () => {
  it.each(JOURNEY.map((j) => [j.label, j] as const))('%s', async (_label, j) => {
    const page = await render(j.path);
    try {
      const hosts = Array.from(page.document.querySelectorAll('.sf-where'));
      expect(hosts, 'a journey page carries exactly one step map host').toHaveLength(1);
      const flow = hosts[0]!.querySelector('ol.stepflow');
      if (j.step === null) {
        expect(flow, 'a hire that ended early lights no step').toBeNull();
        expect((hosts[0] as HTMLElement).hidden).toBe(true);
        return;
      }
      expect(flow, 'the map did not render').not.toBeNull();
      expect(reachable(flow!), 'the map rendered inside something hidden').toBe(true);
      const steps = Array.from(flow!.querySelectorAll('.sf-step'));
      expect(steps).toHaveLength(5);
      const lit = steps.map((s, i) => (s.classList.contains('sf-now') ? i + 1 : 0)).filter(Boolean);
      if (j.step === 'done') {
        expect(lit, 'no step is lit when every step is done').toEqual([]);
        expect(steps.every((s) => s.classList.contains('sf-past'))).toBe(true);
        expect(flow!.getAttribute('data-sf-current')).toBe('done');
      } else {
        expect(lit).toEqual([j.step]);
        expect(steps[j.step - 1]!.getAttribute('aria-current')).toBe('step');
        expect(steps.slice(0, j.step - 1).every((s) => s.classList.contains('sf-past'))).toBe(true);
        expect(steps.slice(j.step).every((s) => s.classList.contains('sf-ahead'))).toBe(true);
      }
      // Never a link: a step on this map is a picture of the process, and
      // most of the pages it would point at refuse without a job id.
      expect(flow!.querySelectorAll('a')).toHaveLength(0);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------ one primary action

describe('at most one primary button is reachable in any state', () => {
  it.each(JOURNEY.map((j) => [j.label, j] as const))('%s', async (_label, j) => {
    const page = await render(j.path);
    try {
      const primaries = Array.from(page.document.querySelectorAll('main .btn-primary')).filter(reachable);
      expect(
        primaries.map((b) => (b.textContent ?? '').trim()),
        'more than one primary button on the screen at once',
      ).toHaveLength(primaries.length > 0 ? 1 : 0);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------------- no jargon

// The card's list, and the DESIGN.md 1.3 table's machine words. Matched as
// whole words against every word a person can reach without opening "Show
// technical details": the page, every state panel the fixture renders, and
// every sheet (dialogs are copy too). Case-insensitive except DID, which
// must stay case-sensitive or the English word "did" counts as jargon.
//
// A DID written out is jargon too, and the one the first version of this
// gate missed: "operated by did:abt:zS1..." has no word "DID" in it, only
// the lowercase scheme. DID_STRING catches any did:<method>:<id> string,
// shortened or whole (A.shortDid keeps the "did:abt:" head), and the
// fixture's own identities are checked by value as well, so the gate fails
// on the exact strings the pages were printing.
const JARGON = ['credential', 'credentials', 'attestation', 'attested', 'hash', 'hashes', 'Ed25519', 'settlement', 'settle', 'settles', 'settled', 'rail', 'rails', 'specHash', 'diffHash'];
const JARGON_EXACT = ['DID', 'DIDs'];
const DID_STRING = /\bdid:[a-z0-9]+:/i;

function machineWords(text: string, identities: ReadonlyArray<string>): string[] {
  const found = [
    ...JARGON.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text)),
    ...JARGON_EXACT.filter((w) => new RegExp(`\\b${w}\\b`).test(text)),
  ];
  const did = DID_STRING.exec(text);
  if (did) found.push(`a DID string at "${text.slice(Math.max(0, did.index - 20), did.index + 30).replace(/\s+/g, ' ')}"`);
  for (const id of identities) {
    // The whole string, or the key-hash form wallets use (didSuffix in
    // api.js), which carries no "did:" head for the regex to catch.
    const suffix = id.replace(/^did:[a-z0-9]+:/i, '');
    if (text.includes(id) || text.includes(suffix)) found.push(`the identity ${id}`);
  }
  return found;
}

describe('the jargon gate itself fails on a planted DID', () => {
  // The gate's own control: it has to say no to the exact string it
  // shipped past once, and yes to the same line in words.
  it.each([
    ['operated by did:abt:zS1JourneyOperator', true],
    ['operated by did:abt:zS1Journe\u2026erator', true],
    ['operated by zS1JourneyOperator', true],
    ['Scan with your DID Wallet', true],
    ['operated by @s1-journey-operator', false],
    ['See who runs this agent', false],
    ['The agent did the work.', false],
  ] as const)('%s', (text, caught) => {
    expect(machineWords(text, [OPERATOR_DID, AGENT_DID]).length > 0).toBe(caught);
  });
});

describe('no machine words on the surface', () => {
  it.each(JOURNEY.map((j) => [j.label, j] as const))('%s', async (_label, j) => {
    const page = await render(j.path);
    try {
      const doc = page.document;
      // Proof the page did fill its identity strip before the check, so an
      // unfilled strip cannot pass by being empty.
      const named = doc.getElementById('agent-name') ?? doc.getElementById('who-agent-name');
      if (named) expect((named.textContent ?? '').trim(), 'the agent strip never filled').not.toBe('Loading');
      doc.querySelectorAll('.detail, script, style, nav, footer').forEach((el) => el.remove());
      doc.querySelectorAll('dialog').forEach((d) => d.setAttribute('open', ''));
      const main = doc.querySelector('main');
      expect(main).not.toBeNull();
      const text = [main!, ...Array.from(doc.querySelectorAll('dialog'))].map((el) => el.textContent ?? '').join(' ');
      // The buyer's DID is left to DID_STRING: its method-specific part is
      // also the buyer's GitHub login in this fixture, a name that may
      // rightly appear.
      expect(machineWords(text, [OPERATOR_DID, AGENT_DID]), `on the surface of ${j.path}`).toEqual([]);
    } finally {
      page.close();
    }
  });
});

// Where the identities went: named in words on the surface, exact in the
// technical details (DESIGN.md 1.3), and the operator link still goes to
// the operator's page.
describe('the agent and operator are named in words, and their DIDs sit in the details', () => {
  it.each([
    ['hire', `/hire?agent=${encodeURIComponent(AGENT_DID)}`, 'operated-by', 'operator-link', 'agent-name'],
    ['deposit', '/deposit?job=s1-proposed', 'operated-by', 'operator-link', 'agent-name'],
    ['job', '/jobs/s1-staged', 'who-operator-line', 'who-operator-link', 'who-agent-name'],
  ] as const)('%s', async (_label, path, rowId, linkId, nameId) => {
    const page = await render(path);
    try {
      const d = page.document;
      expect(d.getElementById(nameId)?.textContent).toBe('s1-journey-scout');
      const row = d.getElementById(rowId) as HTMLElement;
      expect(row.hidden, 'the operator line stayed hidden').toBe(false);
      expect((row.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe('operated by @s1-journey-operator');
      expect(d.getElementById(linkId)?.getAttribute('href')).toBe(`/accounts/${encodeURIComponent(OPERATOR_DID)}`);
      const agentWrap = d.getElementById('tech-agent-did-wrap') as HTMLElement;
      const operatorWrap = d.getElementById('tech-operator-did-wrap') as HTMLElement;
      expect(agentWrap.closest('.detail'), 'the exact identity is not inside a details panel').not.toBeNull();
      expect(agentWrap.hidden).toBe(false);
      expect(operatorWrap.hidden).toBe(false);
      expect(d.getElementById('tech-agent-did')?.textContent).toBe(AGENT_DID);
      expect(d.getElementById('tech-operator-did')?.textContent).toBe(OPERATOR_DID);
    } finally {
      page.close();
    }
  });

  it('an agent with no name and an operator with no GitHub login are still named in words', async () => {
    const page = await render(`/hire?agent=${encodeURIComponent(QUIET_AGENT_DID)}`);
    try {
      const d = page.document;
      expect(d.getElementById('agent-name')?.textContent).toBe('This agent');
      const row = d.getElementById('operated-by') as HTMLElement;
      expect(row.hidden).toBe(false);
      expect((row.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe('See who runs this agent');
      expect(d.getElementById('operator-link')?.getAttribute('href')).toBe(`/accounts/${encodeURIComponent(QUIET_OPERATOR_DID)}`);
      expect(d.getElementById('tech-operator-did')?.textContent).toBe(QUIET_OPERATOR_DID);
      d.querySelectorAll('.detail, script, style, nav, footer').forEach((el) => el.remove());
      expect(machineWords(d.querySelector('main')?.textContent ?? '', [QUIET_AGENT_DID, QUIET_OPERATOR_DID])).toEqual([]);
    } finally {
      page.close();
    }
  });
});

// ---------------------------------------------------------- the detail moved

describe('every link to the moved detail names it and lands on it', () => {
  it('each .sf-more link has words that say what is behind it, and its target exists', async () => {
    const seen = new Map<string, string>();
    for (const page of Object.keys(BEFORE)) {
      const doc = new JSDOM(pageSource(page)).window.document;
      doc.querySelectorAll('a.sf-more').forEach((a) => {
        const href = a.getAttribute('href');
        if (href) seen.set(`${page}: ${(a.textContent ?? '').trim()}`, href);
      });
    }
    // hire, deposit, staged and pull request each point somewhere; the job
    // page's detail is its own technical panel.
    expect(seen.size, 'no moved-detail links found: the selector broke').toBeGreaterThanOrEqual(4);
    for (const [where, href] of seen) {
      expect(where.split(': ')[1]!.split(/\s+/).length, `"${where}" is too vague to say what is behind it`).toBeGreaterThanOrEqual(4);
      const [path, hash] = href.split('#');
      const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
      expect(res.status, `${where} -> ${href}`).toBe(200);
      if (hash) {
        const target = new JSDOM(await res.text()).window.document.getElementById(hash);
        expect(target, `${where} -> ${href}: no #${hash} on that page`).not.toBeNull();
      }
    }
  });
});

// ------------------------------------------------------- the money is exact

const $ = (amount: string): string => `$${parseFloat(amount).toFixed(2)}`;

describe('every amount is what payment.ts computes for the same price', () => {
  it('deposit: the total, its parts, both rail totals and the balance still to pay', async () => {
    const page = await render('/deposit?job=s1-proposed');
    try {
      const d = page.document;
      const deposit = depositUsd(PRICE, 25);
      const abtFee = calculateFee(deposit, ABT_FEE_RATE_PERCENT);
      const usdcFee = calculateFee(deposit, USDC_FEE_RATE_PERCENT);
      const abtTotal = (parseFloat(deposit) + parseFloat(abtFee)).toFixed(2);
      const usdcTotal = (parseFloat(deposit) + parseFloat(usdcFee)).toFixed(2);
      expect(d.getElementById('total-amount')?.textContent).toBe(`$${abtTotal}`);
      expect(d.getElementById('deposit-amount')?.textContent).toBe($(deposit));
      expect(d.getElementById('fee-amount')?.textContent).toBe($(abtFee));
      expect(d.getElementById('rail-abt-amt')?.textContent).toBe(`$${abtTotal} today`);
      expect(d.getElementById('rail-usdc-amt')?.textContent).toBe(`$${usdcTotal} today`);
      expect(d.getElementById('deposit-label')?.textContent).toBe(`Deposit, 25 percent of the ${$(PRICE)} price`);
      const counts = d.getElementById('counts-toward-line')?.textContent ?? '';
      expect(counts).toContain($(PRICE));
      expect(counts).toContain($(remainderUsd(PRICE, 25)));
      expect(d.getElementById('finality-line')?.textContent).toContain(`${$(deposit)} deposit does not come back`);
      expect(d.getElementById('pay-btn')?.textContent).toBe(`Pay $${abtTotal} with your wallet`);
      // Who is paid: the operator directly, never the platform.
      expect(d.querySelector('.total .when')?.textContent).toBe('Paid straight to the operator. FreeAgents never holds it.');
      expect(d.getElementById('byline')?.textContent).toBe('Ready 6 days after this payment clears');
    } finally {
      page.close();
    }
  });

  it('staged: the balance, its fee, the deposit that stays with the operator, and the deadline', async () => {
    const page = await render('/staged?job=s1-staged');
    try {
      const d = page.document;
      const remainder = remainderUsd(PRICE, 25);
      const fee = calculateFee(remainder, ABT_FEE_RATE_PERCENT);
      const total = (parseFloat(remainder) + parseFloat(fee)).toFixed(2);
      expect(d.getElementById('pay-btn')?.textContent).toBe(`Pay the balance, $${total}`);
      const pay = d.querySelector('#choices li .para')?.textContent ?? '';
      expect(pay).toContain(`${$(remainder)} of the ${$(PRICE)} price, plus the 3 percent fee`);
      expect(d.getElementById('clock-then')?.textContent).toContain(`the ${$(depositUsd(PRICE, 25))} deposit stays with the operator`);
      expect(d.getElementById('clock-days')?.textContent).toMatch(/^7 days to decide/);
      expect(Array.from(d.querySelectorAll('#decline-consequences .v')).map((v) => v.textContent)).toContain(
        `${$(depositUsd(PRICE, 25))} stays with the operator`,
      );
    } finally {
      page.close();
    }
  });

  it('job: the price names how it was paid in words, never the raw rail value', async () => {
    const page = await render('/jobs/s1-staged');
    try {
      expect(page.document.getElementById('fact-price')?.textContent).toBe(`$${PRICE}, paid in ABT`);
    } finally {
      page.close();
    }
  });

  it('pull request: both legs, each with its fee, paid buyer to operator', async () => {
    const page = await render('/pullrequest?job=s1-submitted');
    try {
      const d = page.document;
      const deposit = depositUsd(PRICE, 25);
      const remainder = remainderUsd(PRICE, 25);
      expect(d.getElementById('tech-deposit')?.textContent).toBe(
        `${$(deposit)} plus ${$(calculateFee(deposit, ABT_FEE_RATE_PERCENT))} fee, buyer to operator`,
      );
      expect(d.getElementById('tech-balance')?.textContent).toBe(
        `${$(remainder)} plus ${$(calculateFee(remainder, ABT_FEE_RATE_PERCENT))} fee, buyer to operator`,
      );
      expect(d.getElementById('clock-days')?.textContent).toMatch(/^7 days to review/);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------------- laid out right

// Every control a person can reach, at the width under test. A link inside
// a sentence is exempt (WCAG 2.5.8), the same rule hire-polished.test.ts
// uses. The nav is measured by its own suite and is left out here.
const SWEEP = `
  (function () {
    function inSentence(a) {
      return [].some.call(a.parentElement.childNodes, function (n) {
        return n.nodeType === 3 && n.textContent.trim().length > 0;
      });
    }
    var doc = document.documentElement;
    var all = [].filter.call(document.querySelectorAll('main a[href], main button, main input, main textarea, dialog[open] a[href], dialog[open] button, dialog[open] input'), function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.type !== 'radio';
    });
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      past: [].filter.call(document.querySelectorAll('body *'), function (el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.right > doc.clientWidth + 0.5 && getComputedStyle(el).position !== 'fixed';
      }).slice(0, 6).map(function (el) { return el.tagName + '#' + el.id + '.' + el.className; }),
      measured: all.length,
      small: all.filter(function (el) {
        var r = el.getBoundingClientRect();
        return (r.width < 44 || r.height < 44) && !(el.tagName === 'A' && inSentence(el));
      }).map(function (el) {
        var r = el.getBoundingClientRect();
        return (el.id || el.className || el.tagName) + ' "' + el.textContent.trim().slice(0, 30) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height);
      })
    };
  })()
`;

interface Sweep {
  scrollWidth: number;
  clientWidth: number;
  past: string[];
  measured: number;
  small: string[];
}

// The states to open on each page before measuring, beyond the page as it
// loads: every disclosure, then each sheet on its own.
const OPENERS: Record<string, ReadonlyArray<string>> = {
  hire: ['disclose'],
  deposit: ['disclose'],
  job: ['disclose'],
  staged: ['disclose', 'dialog#redo', 'dialog#decline', 'dialog#scan'],
  pullrequest: ['disclose', 'dialog#close'],
};

const captureDir = process.env.S1_CAPTURE_DIR ?? '';

async function capture(browser: RealBrowser, name: string): Promise<void> {
  if (captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  // base.css:406 holds every .reveal at opacity 0 until it intersects. A
  // full-page capture does not scroll, so scroll through first or the shot
  // shows empty bands a person never sees.
  await browser.evaluate(`(async function () { for (var y = 0; y < document.documentElement.scrollHeight; y += 300) { scrollTo(0, y); await new Promise(function (r) { setTimeout(r, 60); }); } scrollTo(0, 0); })()`);
  await new Promise((r) => setTimeout(r, 900));
  const metrics = (await browser.send('Page.getLayoutMetrics')) as { result?: { cssContentSize?: { height: number } } };
  const height = Math.ceil(metrics.result?.cssContentSize?.height ?? 900);
  const shot = (await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: await browser.evaluate<number>('document.documentElement.clientWidth'), height, scale: 1 } })) as { result?: { data?: string } };
  if (shot.result?.data) writeFileSync(join(captureDir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
}

describe('laid out right at 1280 and 320, in every state a page opens', () => {
  const PAGES = JOURNEY.filter((j) => ['hire', 'deposit', 'job, staged', 'job, completed', 'staged', 'pullrequest'].includes(j.label));

  for (const width of [1280, 320]) {
    it.each(PAGES.map((j) => [j.label, j] as const))(`${width}px: %s`, async (_label, j) => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for the journey layout sweep; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width, height: 900 });
      try {
        if (width === 320) {
          await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 2, mobile: true });
          await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        }
        await browser.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(buyerSession))});`,
        });
        await browser.goto(`${baseUrl}${j.path}`, 1500);
        const shotName = `${j.label.replace(/[^a-z]+/g, '-')}-${width}`;
        await capture(browser, shotName);

        const loaded = await browser.evaluate<Sweep>(SWEEP);
        expect(loaded.measured, 'nothing to measure: the page did not render its body').toBeGreaterThan(1);
        expect(loaded.past, `${j.label} at ${width}: past the right edge`).toEqual([]);
        expect(loaded.scrollWidth).toBe(loaded.clientWidth);
        // The 44px floor is a touch rule (the card's mobile QA law), checked
        // at 320 with touch emulated. At 1280 the site's shared button system
        // is 40px tall, a pointer size owned by ui.css and not by this card.
        if (width === 320) expect(loaded.small, `${j.label} at ${width}: under 44px`).toEqual([]);

        for (const opener of OPENERS[j.page] ?? []) {
          if (opener === 'disclose') {
            await browser.evaluate(`[].forEach.call(document.querySelectorAll('main .disclose'), function (b) { if (b.getAttribute('aria-expanded') !== 'true') b.click(); })`);
          } else {
            await browser.evaluate(`[].forEach.call(document.querySelectorAll('dialog[open]'), function (d) { d.close(); }); document.querySelector(${JSON.stringify(opener)}).showModal()`);
          }
          await new Promise((r) => setTimeout(r, 250));
          const open = await browser.evaluate<Sweep>(SWEEP);
          expect(open.past, `${j.label} at ${width} with ${opener} open: past the right edge`).toEqual([]);
          expect(open.scrollWidth, `${j.label} at ${width} with ${opener} open: sideways scroll`).toBe(open.clientWidth);
          if (width === 320) expect(open.small, `${j.label} at ${width} with ${opener} open: under 44px`).toEqual([]);
          if (opener === 'disclose' && width === 320) await capture(browser, `${shotName}-details-open`);
          if (opener.startsWith('dialog') && width === 320) await capture(browser, `${shotName}-${opener.slice(7)}-open`);
        }
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);
  }

  it.each([['no-preference'], ['reduce']])('the map is finished and still, prefers-reduced-motion: %s', async (motion) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the journey layout sweep; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
      await browser.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(buyerSession))});`,
      });
      await browser.goto(`${baseUrl}/staged?job=s1-staged`, 1200);
      const state = await browser.evaluate<{ matches: boolean; cls: string; styles: string[] }>(`({
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        cls: document.querySelector('.sf-where ol').className,
        styles: [].map.call(document.querySelectorAll('.sf-where .sf-label, .sf-where .sf-now .sf-node'), function (el) {
          var cs = getComputedStyle(el); return cs.opacity + '|' + cs.transform;
        })
      })`);
      expect(state.matches).toBe(motion === 'reduce');
      expect(state.cls).not.toMatch(/sf-armed|sf-play/);
      expect(state.styles).toEqual(Array(6).fill('1|none'));
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
