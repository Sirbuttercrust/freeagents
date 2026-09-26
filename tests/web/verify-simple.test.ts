// S3: the verify journey, simple. The page a skeptic is sent to from a
// receipt, taken to the landing page's level of simple the way S1 took the
// hire journey and S2 the agent page and the receipt, and made one click from
// every verified hire and every receipt. What that promises is pinned here as
// rules rather than as copy:
//
//   (a) a word ceiling    verify.html ships at most 280 words inside exactly
//                         one <main> (490 before), and what a person meets
//                         on arrival (every .detail and [hidden] removed) at
//                         most 120 (267 before), by S1's counting rule
//   (b) one <main>        between the nav and the footer
//   (c) no machine words  nothing from S1's jargon list, the proof-format
//                         names, a command or an identity string on the
//                         surface of any state the page renders
//   (d) nothing lost      every technical field is present and filled behind
//                         the three disclosures once a receipt loads
//   (e) easy to find      a verified-hire row on the agent page links to the
//                         filled verify page, a claim row does not, the
//                         receipt's two links land on the filled page, and
//                         every page's footer links /verify
//   (f) one primary       at most one primary button in each state
//   (g) no session        the page fills a receipt with no sign-in, and
//                         nothing on it reads or posts to a sign-in route
//   (h) laid out right    at 1280 and 320 in real Chrome, each state, each
//                         disclosure open in turn: no sideways scroll and
//                         every control 43.95px or more
//
// Set S3_CAPTURE_DIR to a directory to have the layout sweep also save a
// full-page screenshot of each state at both widths. Off by default.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import type { Job } from '../../src/domain/job.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { agentPageReady, receiptPageReady, settled } from '../helpers/page-settled.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const pagesDir = join(repoRoot, 'src/web/pages');
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const BROWSER_TIMEOUT_MS = 120_000;

// ------------------------------------------------------------ the ceilings

// verify.html before S3 (origin/main at 5c09280), by static_words.py: no
// <main>, so the whole file, 490; the arrival view with head, nav and footer
// taken out by hand, 267.
const BEFORE = { total: 490, arrival: 267 } as const;
const CEILING = 280;
const ARRIVAL_CEILING = 120;

// static_words.py, ported line for line (the port S1's and S2's tests
// carry): <main> to </main>, then script, style and template blocks out,
// then comments out, then tags to spaces, then entities decoded, then split
// on whitespace. Hidden state panels count: they are copy the page ships.
function staticWords(src: string): string[] {
  const m = src.match(/<main[\s\S]*?<\/main>/);
  let body = m ? m[0] : src;
  body = body.replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  const text = body.replace(/<[^>]+>/g, ' ');
  const decoded = new JSDOM(`<p>${text.replace(/</g, '&lt;')}</p>`).window.document.body.textContent ?? '';
  return decoded.split(/\s+/).filter(Boolean);
}

// The arrival view: <main> with every .detail and every [hidden] element
// removed (arrival_words.py's rule), then counted the same way. Parsed, not
// regexed, so a nested div cannot end a cut early.
function arrivalWords(src: string): string[] {
  const doc = new JSDOM(src).window.document;
  const main = doc.querySelector('main');
  if (main === null) return staticWords(src);
  main.querySelectorAll('.detail, [hidden]').forEach((el) => el.remove());
  return staticWords(main.outerHTML);
}

const verifySource = (): string => readFileSync(join(pagesDir, 'verify.html'), 'utf8');

describe('(a) the counter itself', () => {
  it('agrees with static_words.py on a known input', () => {
    const src = '<nav>Nav words</nav><main><!-- a <b>note</b> --><h1>One&nbsp;two</h1><script>var x = "no";</script><template><p>no</p></template><p>three &amp; four</p></main>';
    expect(staticWords(src)).toEqual(['One', 'two', 'three', '&', 'four']);
  });

  it('the arrival view drops .detail and [hidden], and nothing else', () => {
    const src =
      '<main><h1>Name here</h1><form hidden><label>hidden form</label></form><div id="x" hidden><div><p>hidden state</p></div></div>' +
      '<button class="disclose">Show more</button><div class="detail"><div>behind a click</div></div><p>after</p></main>';
    expect(arrivalWords(src)).toEqual(['Name', 'here', 'Show', 'more', 'after']);
  });
});

describe('(a) verify.html is at or under both ceilings', () => {
  it(`in total, at most ${CEILING} (was ${BEFORE.total})`, () => {
    const words = staticWords(verifySource());
    expect(words.length, `verify: ${words.length} words, ceiling ${CEILING}. The copy: ${words.join(' ')}`).toBeLessThanOrEqual(CEILING);
  });

  it(`on arrival, at most ${ARRIVAL_CEILING} (was ${BEFORE.arrival})`, () => {
    const words = arrivalWords(verifySource());
    expect(words.length, `verify arrival: ${words.length} words, ceiling ${ARRIVAL_CEILING}. The copy: ${words.join(' ')}`).toBeLessThanOrEqual(
      ARRIVAL_CEILING,
    );
  });
});

describe('(b) exactly one <main>, between the nav and the footer', () => {
  it('verify', () => {
    const src = verifySource();
    expect(src.match(/<main\b/g)?.length ?? 0, 'verify must have exactly one <main>, or the count reads the whole file').toBe(1);
    const doc = new JSDOM(src).window.document;
    const main = doc.querySelector('main')!;
    const nav = doc.querySelector('nav.nav')!;
    const foot = doc.querySelector('footer.foot')!;
    expect(Boolean(nav.compareDocumentPosition(main) & 0x04), 'the nav comes before <main>').toBe(true);
    expect(Boolean(main.compareDocumentPosition(foot) & 0x04), '<main> comes before the footer').toBe(true);
    expect(main.contains(nav) || main.contains(foot), 'the nav and footer stay outside <main>').toBe(false);
    // Every piece of the page is inside it: nothing but the nav, <main>, the
    // footer and scripts sits in <body>.
    const loose = Array.from(doc.body.children).filter((el) => !['NAV', 'MAIN', 'FOOTER', 'SCRIPT', 'TEMPLATE'].includes(el.tagName));
    expect(loose.map((el) => `${el.tagName}.${el.className}`), 'page content outside <main>').toEqual([]);
  });
});

// ------------------------------------------------------------ the fixtures

const OPERATOR_DID = 'did:abt:zS3VerifyOperator';
const AGENT_DID = 'did:abt:zS3VerifyAgent';
const AGENT_NAME = 's3-verify-scout';
const BUYER_DID = 'did:abt:zS3VerifyBuyer';
const ISSUER = 'did:abt:platform';

// A verified hire and a portfolio claim (a merge into a private repository
// demotes to the claim tier, MISSION invariant 4).
const HIRE = { id: 's3-job-hire', repository: 'buyer/s3-shop', mergeCommit: 's3mergehire00001', buyer: BUYER_DID, public: true, pr: 7 };
const CLAIM = { id: 's3-job-claim', repository: 'buyer/s3-private', mergeCommit: 's3mergeclaim0002', buyer: BUYER_DID, public: false, pr: 9 };
const JOBS = [HIRE, CLAIM];
const MERGED_AT = '2026-09-10T00:00:00.000Z';
const SIGNING_KEY = `${AGENT_DID}#key-1`;
const MISSING = 's3-no-such-receipt';

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:s3-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-01T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-01T00:00:00.000Z',
      verificationMethod: `${operatorDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zS3FixtureNotVerifiedHere',
    },
  };
}

function credentialDoc(job: (typeof JOBS)[number]): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://platform.example/v1/credentials/${job.id}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: ISSUER,
    validFrom: MERGED_AT,
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:s3-brief',
        repository: job.repository,
        pullRequest: `https://github.com/${job.repository}/pull/${job.pr}`,
        mergedAt: MERGED_AT,
        mergeCommit: job.mergeCommit,
        signedBy: SIGNING_KEY,
        buyer: job.buyer,
        additions: 12,
        deletions: 2,
        filesChanged: 2,
        specHash: 'sha256:s3-spec',
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zS3Proof' },
  };
}

function jobFixture(id: string, buyerDid: string, repository: string): Job {
  return {
    id,
    agentDid: AGENT_DID,
    buyerDid,
    requestId: null,
    repository,
    brief: 'Keep the cart when the page reloads.',
    briefHash: 'sha256:s3-brief',
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
    createdAt: new Date('2026-09-01T00:00:00Z'),
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
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();

  await accountRepo.register({ did: OPERATOR_DID, githubLogin: 's3-verify-operator' });
  await accountRepo.register({ did: BUYER_DID, githubLogin: 's3-verify-buyer' });
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_DID, OPERATOR_DID),
    name: AGENT_NAME,
    skills: ['websites'],
    githubLogin: null,
  });

  for (const j of JOBS) {
    const draft = jobFixture(j.id, j.buyer, j.repository);
    await jobRepo.create(draft);
    await jobRepo.complete(
      { ...draft, status: 'completed', mergeCommit: j.mergeCommit, mergedAt: new Date(MERGED_AT) },
      { jobId: j.id, buyerDid: j.buyer, agentDid: AGENT_DID, mergeCommit: j.mergeCommit, completedAt: new Date(MERGED_AT) },
    );
    await credentialRepo.save({ completedJobId: j.id, subjectDid: AGENT_DID, document: credentialDoc(j), repositoryPublic: j.public });
  }

  server = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const verifyPath = (key: string): string => `/verify?credential=${encodeURIComponent(key)}`;
const agentPath = (did: string): string => `/agents/${encodeURIComponent(did)}`;
const receiptPath = (id: string): string => `/v1/credentials/${id}`;

interface Rendered {
  document: Document;
  requests: Array<{ url: string; method: string }>;
  storageReads: string[];
  close: () => void;
}

const shown = (doc: Document, id: string): boolean => {
  const el = doc.getElementById(id) as HTMLElement | null;
  return el !== null && !el.hidden;
};

// The verify page is done when one of its three states is up. With a
// receipt, it waits for the agent's name too: the claim names the agent
// from a second read, and a page that never names it must fail on the
// assertion, not on this helper, so that wait is best-effort.
function verifyReady(doc: Document): boolean {
  return shown(doc, 'loaded') || shown(doc, 'load-error') || shown(doc, 'lookup');
}

// The page with its own scripts run for real. Every request it makes and
// every read of sessionStorage or localStorage is recorded, for (g).
async function render(path: string): Promise<Rendered> {
  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const requests: Array<{ url: string; method: string }> = [];
  const storageReads: string[] = [];
  const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } });
  expect(res.status, path).toBe(200);
  const dom = new JSDOM(await res.text(), {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          requests.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() });
          return fetch(new URL(input, baseUrl), init);
        },
      });
      for (const store of ['sessionStorage', 'localStorage'] as const) {
        const real = window[store];
        const getItem = real.getItem.bind(real);
        real.getItem = (key: string): string | null => {
          storageReads.push(`${store}.${key}`);
          return getItem(key);
        };
      }
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  const doc = dom.window.document;
  if (path.startsWith('/agents/')) {
    await settled(doc, agentPageReady, path);
  } else if (path.startsWith('/v1/credentials/')) {
    await settled(doc, receiptPageReady, path);
  } else {
    await settled(doc, verifyReady, path);
    if (shown(doc, 'loaded')) {
      const deadline = Date.now() + 2500;
      while (doc.querySelector('#claim b')?.textContent !== AGENT_NAME && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const real = failures.filter((m) => !m.includes('Not implemented'));
  if (real.length > 0) throw new Error(`page script failed on ${path}: ${real.join('; ')}`);
  return { document: doc, requests, storageReads, close: () => dom.window.close() };
}

function reachable(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if ((n as HTMLElement).hidden) return false;
    if (n.tagName === 'DIALOG' && !n.hasAttribute('open')) return false;
    if (n.classList.contains('detail')) return false;
  }
  return true;
}

const squash = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

const STATES: ReadonlyArray<readonly [string, string]> = [
  ['no receipt asked for', '/verify'],
  ['a receipt that will not load', verifyPath(MISSING)],
  ['a receipt loaded', verifyPath(HIRE.id)],
];

// ------------------------------------------------------------- no jargon

// S1's list (tests/web/hire-journey-simple.test.ts JARGON and JARGON_EXACT),
// plus the words this card names: the proof format, the document type, the
// command, the resolver and the identity method. Whole words, case-blind,
// except the ones an English sentence could hold in lower case (DID, API).
// A DID string in any form, and every exact value the fixture puts into the
// receipt, is checked by value as well.
const JARGON = [
  'credential', 'credentials', 'attestation', 'attested', 'hash', 'hashes', 'Ed25519', 'settlement', 'settle', 'settles', 'settled',
  'rail', 'rails', 'specHash', 'diffHash', 'W3C', 'Verifiable Credential', 'Ed25519Signature2020', 'curl', 'resolver',
  'identity document', 'abt',
];
const JARGON_EXACT = ['DID', 'DIDs', 'API'];
const DID_STRING = /\bdid:[a-z0-9]+:/i;
const EXACT_VALUES = [AGENT_DID, ISSUER, SIGNING_KEY, HIRE.mergeCommit, HIRE.id, 'zS3VerifyAgent', 'sha256:'];

function machineWords(text: string): string[] {
  const found = [
    ...JARGON.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text)),
    ...JARGON_EXACT.filter((w) => new RegExp(`\\b${w}\\b`).test(text)),
  ];
  const did = DID_STRING.exec(text);
  if (did) found.push(`a DID string at "${squash(text.slice(Math.max(0, did.index - 20), did.index + 30))}"`);
  for (const value of EXACT_VALUES) if (text.includes(value)) found.push(`the exact value ${value}`);
  return found;
}

describe('(c) the machine-word gate itself', () => {
  // Its own control: it says no to each kind of exact term and yes to the
  // same line in plain words.
  it.each([
    ['s3-verify-scout shipped work, see did:abt:zS3VerifyAgent', true],
    ['did:abt:zS3Veri\u2026Agent shipped work', true],
    ['Signed with Ed25519Signature2020.', true],
    ['A W3C Verifiable Credential', true],
    ['curl -s https://api.github.com/repos/buyer/s3-shop/pulls/7', true],
    ['Two calls to GitHub\u2019s own public API', true],
    ['Any resolver for the abt method', true],
    ['merge s3mergehire00001', true],
    ['s3-verify-scout shipped work to buyer/s3-shop, and this receipt says it merged.', false],
    ['Proves the receipt came from us and nobody changed it.', false],
    ['The agent did the work, and GitHub merged it.', false],
  ] as const)('%s', (text, caught) => {
    expect(machineWords(text).length > 0, JSON.stringify(machineWords(text))).toBe(caught);
  });
});

describe('(c) no machine words on the surface, in each state', () => {
  it.each(STATES)('%s', async (_label, path) => {
    const page = await render(path);
    try {
      const doc = page.document;
      const main = doc.querySelector('main');
      expect(main, 'the surface is <main>').not.toBeNull();
      doc.querySelectorAll('.detail, script, style, nav, footer, template').forEach((el) => el.remove());
      const text = main!.textContent ?? '';
      expect(machineWords(text), `on the surface of ${path}: ${squash(text)}`).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('the surface says what the page is, what each check proves, and what the receipt claims', async () => {
    const page = await render(verifyPath(HIRE.id));
    try {
      const d = page.document;
      // What the page is: anyone can check a finished job's receipt, without
      // trusting us and without an account.
      expect(squash(d.getElementById('intro')?.textContent)).toBe(
        'Every finished job gets a receipt. Anyone can check it without trusting us, and without an account.',
      );
      // Each check: one heading and one plain line saying what it proves.
      const checks = Array.from(d.querySelectorAll('main .checked > div'));
      expect(checks.map((c) => squash(c.querySelector('.h')?.textContent))).toEqual([
        'The signature checks out',
        'The pull request is real, and it merged',
        "The author matches the agent's proven account",
      ]);
      for (const c of checks) {
        const line = squash(c.querySelector('.d')?.textContent);
        expect(line, 'a check with no plain line').toMatch(/^Proves /);
        expect(line.split(' ').length, `"${line}" is more than one short line`).toBeLessThanOrEqual(12);
      }
      // What was claimed, naming the agent by its name, never its identity.
      expect(squash(d.getElementById('claim')?.textContent)).toMatch(
        new RegExp(`^${AGENT_NAME} shipped work to ${HIRE.repository}, and this receipt says it merged on .+\\.$`),
      );
    } finally {
      page.close();
    }
  });
});

// --------------------------------------------------- the technical half

describe('(d) every technical field is present and filled behind the three disclosures', () => {
  it('with a receipt loaded', async () => {
    const page = await render(verifyPath(HIRE.id));
    try {
      const d = page.document;
      const panel = (id: string): Element => {
        const el = d.getElementById(id);
        expect(el, `#${id} is not on the page`).not.toBeNull();
        expect(el!.classList.contains('detail'), `#${id} is not a disclosure panel`).toBe(true);
        expect(d.querySelector(`main .disclose[data-disclose="${id}"]`), `no disclosure opens #${id}`).not.toBeNull();
        return el!;
      };
      const sig = panel('sigcheck');
      const gh = panel('ghcheck');
      const id = panel('idcheck');

      // Each value and its copy control, inside the panel it belongs to.
      const fields: Array<[Element, string, string]> = [
        [sig, 'cmd-fetch', `curl -sH 'Accept: application/ld+json' ${baseUrl}${receiptPath(HIRE.id)}`],
        [sig, 'issuer', ISSUER],
        [gh, 'cmd-pr', `curl -s https://api.github.com/repos/${HIRE.repository}/pulls/${HIRE.pr}`],
        [gh, 'cmd-commit', `curl -s https://api.github.com/repos/${HIRE.repository}/commits/${HIRE.mergeCommit}`],
        [id, 'agent-did', AGENT_DID],
        [id, 'signer', SIGNING_KEY],
      ];
      for (const [host, fieldId, value] of fields) {
        const cell = d.getElementById(fieldId);
        expect(cell, `#${fieldId} is not on the page`).not.toBeNull();
        expect(host.contains(cell), `#${fieldId} is not behind its disclosure`).toBe(true);
        expect(squash(cell!.textContent), `#${fieldId}`).toBe(value);
        const copy = d.getElementById(`${fieldId}-copy`) as HTMLElement | null;
        expect(copy?.getAttribute('data-copy'), `#${fieldId}-copy copies something else`).toBe(value);
        expect(copy?.hidden, `#${fieldId}-copy is hidden`).toBe(false);
      }

      // Download JSON: the receipt document itself.
      const dl = d.getElementById('sig-download-link') as HTMLElement;
      expect(sig.contains(dl)).toBe(true);
      expect(dl.hidden).toBe(false);
      expect(dl.hasAttribute('download')).toBe(true);
      expect(dl.getAttribute('href')).toBe(receiptPath(HIRE.id));
      expect(squash(dl.textContent)).toBe('Download JSON');

      // The proof type by name, and a verifier that checks it.
      const sigText = squash(sig.textContent);
      expect(sigText).toContain('Ed25519Signature2020');
      expect(sigText).toContain('W3C Verifiable Credential');
      expect(sigText).toMatch(/Digital Bazaar's vc library/);
      expect(sigText).toMatch(/never contacts this site/);

      // What to look for in GitHub's two answers.
      const ghText = squash(gh.textContent);
      expect(ghText).toContain('"merged": true');
      expect(ghText).toContain('"verification": { "verified": true }');

      // Any resolver for the abt method returns the same identity document.
      const idText = squash(id.textContent);
      expect(idText).toMatch(/Any resolver for the abt method returns the same identity document, without us\./);
      expect(idText).toMatch(/the one GitHub reports for the merge commit/);
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------- easy to find

// A verify page counts as filled when it names the agent in the claim and
// its commands carry the receipt's own values.
function expectFilledFor(d: Document, job: (typeof JOBS)[number], via: string): void {
  expect(shown(d, 'loaded'), `${via}: the verify page did not load the receipt`).toBe(true);
  expect(squash(d.getElementById('claim')?.textContent), via).toMatch(new RegExp(`^${AGENT_NAME} shipped work to ${job.repository}`));
  expect(squash(d.getElementById('cmd-pr')?.textContent), via).toBe(`curl -s https://api.github.com/repos/${job.repository}/pulls/${job.pr}`);
}

describe('(e) one click from every verified hire and every receipt', () => {
  it('a verified-hire row links to the filled verify page; a claim row does not', async () => {
    const page = await render(agentPath(AGENT_DID));
    let href = '';
    try {
      const d = page.document;
      expect(d.querySelector('main'), 'no <main>').not.toBeNull();
      const hireRow = d.getElementById('history')?.firstElementChild;
      expect(hireRow, 'no verified-hire row rendered').toBeTruthy();
      const links = Array.from(hireRow!.querySelectorAll('a.verify'));
      expect(links.map((a) => squash(a.textContent))).toEqual(['See the receipt', 'Check this yourself']);
      expect(links[0]!.getAttribute('href')).toBe(receiptPath(HIRE.id));
      href = links[1]!.getAttribute('href') ?? '';
      expect(href).toBe(`/verify?credential=${HIRE.id}`);
      // Plain words, never a second primary button on the page.
      expect(links[1]!.classList.contains('btn-primary')).toBe(false);

      const claimRow = d.getElementById('portfolio')?.firstElementChild;
      expect(claimRow, 'no claim row rendered').toBeTruthy();
      expect(claimRow!.querySelectorAll('a[href*="/verify"], a.verify'), 'a claim row offers a check').toHaveLength(0);
      expect(claimRow!.textContent).toContain('We cannot check this.');
    } finally {
      page.close();
    }
    const landed = await render(href);
    try {
      expectFilledFor(landed.document, HIRE, 'the agent row');
    } finally {
      landed.close();
    }
  });

  it('the new link costs no static words: it lives in a <template>', () => {
    const doc = new JSDOM(readFileSync(join(pagesDir, 'agent.html'), 'utf8')).window.document;
    const tmpl = doc.getElementById('tmpl-verify-check') as HTMLTemplateElement | null;
    expect(tmpl?.tagName).toBe('TEMPLATE');
    expect(squash(tmpl!.content.textContent)).toBe('Check this yourself');
  });

  it.each([
    ['verify-link', 'Check this yourself'],
    ['raw-verify-link', 'Check the signature'],
  ])("the receipt's %s lands on the filled verify page", async (id, words) => {
    const page = await render(receiptPath(HIRE.id));
    let href = '';
    try {
      const link = page.document.getElementById(id);
      expect(squash(link?.textContent)).toBe(words);
      href = link?.getAttribute('href') ?? '';
      expect(href).toBe(`/verify?credential=${HIRE.id}`);
    } finally {
      page.close();
    }
    const landed = await render(href);
    try {
      expectFilledFor(landed.document, HIRE, id);
    } finally {
      landed.close();
    }
  });

  // The footer rule, over every built page. auth-callback-success is a
  // one-line redirect with no footer; landing's footer is div.foot.
  const NO_FOOTER = new Set(['auth-callback-success']);
  const footerLinksVerify = (src: string): boolean => {
    const doc = new JSDOM(src).window.document;
    const foot = doc.querySelector('footer, .foot');
    return foot !== null && foot.querySelector('a[href="/verify"]') !== null;
  };
  const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));

  it('the footer check catches a page whose footer drops the link (planted control)', () => {
    expect(footerLinksVerify('<footer class="foot"><a href="/how">How it works</a></footer>')).toBe(false);
    expect(footerLinksVerify('<main></main>')).toBe(false);
    expect(footerLinksVerify('<div class="foot"><a href="/verify">Verify</a></div>')).toBe(true);
    expect(pages.length, 'no pages found: the selector broke').toBeGreaterThan(20);
  });

  it.each(pages.filter((p) => !NO_FOOTER.has(p)))('%s: the footer links /verify', (name) => {
    expect(footerLinksVerify(readFileSync(join(pagesDir, `${name}.html`), 'utf8'))).toBe(true);
  });
});

// ------------------------------------------------------ one primary action

describe('(f) at most one primary button in each state, and the lookup and the loaded state have exactly one', () => {
  it.each([
    ['no receipt asked for', '/verify', 'Look it up'],
    ['a receipt that will not load', verifyPath(MISSING), 'Look it up'],
    ['a receipt loaded', verifyPath(HIRE.id), 'Open the pull request on GitHub'],
  ])('%s', async (_label, path, expected) => {
    const page = await render(path);
    try {
      const d = page.document;
      expect(d.querySelector('main'), 'no <main>').not.toBeNull();
      // Every primary on the page outside the shared nav and footer, not only
      // inside <main>: a primary left outside it still competes.
      const primaries = Array.from(d.querySelectorAll('.btn-primary')).filter((b) => reachable(b) && b.closest('nav, footer') === null);
      expect(primaries.map((b) => squash(b.textContent))).toEqual([expected]);
      expect(primaries[0]!.closest('main'), 'the primary sits outside <main>').not.toBeNull();
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------------ no session

// Routes that sign a person in or read their session. MISSION invariant 2
// and SITEMAP P-6: checking someone else's work never needs an account.
const SESSION_ROUTE = /^\/?(auth\/|signin\b|accounts\/me\b|session)/;
const pathOf = (u: string): string => new URL(u, 'http://x').pathname;

describe('(g) the page works without an account, and nothing on it reaches for one', () => {
  it('the route check catches a sign-in route and passes a receipt read (planted control)', () => {
    expect(SESSION_ROUTE.test(pathOf('/auth/github/start').slice(1))).toBe(true);
    expect(SESSION_ROUTE.test(pathOf('/signin').slice(1))).toBe(true);
    expect(SESSION_ROUTE.test(pathOf('/accounts/me').slice(1))).toBe(true);
    expect(SESSION_ROUTE.test(pathOf(`/v1/credentials/${HIRE.id}`).slice(1))).toBe(false);
    expect(SESSION_ROUTE.test(pathOf('/verify?credential=x').slice(1))).toBe(false);
  });

  it.each(STATES)('%s', async (_label, path) => {
    const page = await render(path);
    try {
      const d = page.document;
      const main = d.querySelector('main');
      expect(main, 'no <main>').not.toBeNull();
      // With no session stored, a receipt still loads and fills.
      if (path === verifyPath(HIRE.id)) expectFilledFor(d, HIRE, 'no session');
      // The page says it needs no account, on its surface.
      expect(squash(arrivalText(main!))).toContain('without an account');
      // Every request the page made is a GET to something other than a
      // sign-in or session route.
      for (const r of page.requests) {
        expect(r.method, `${r.url}`).toBe('GET');
        expect(SESSION_ROUTE.test(pathOf(r.url).slice(1)), `the page reached for ${r.url}`).toBe(false);
      }
      // No control in <main> goes to one either, and nothing asks for a password.
      const targets = [
        ...Array.from(main!.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? ''),
        ...Array.from(main!.querySelectorAll('form')).map((f) => f.getAttribute('action') ?? ''),
        ...Array.from(main!.querySelectorAll('[formaction]')).map((b) => b.getAttribute('formaction') ?? ''),
      ].filter((t) => t.startsWith('/'));
      expect(targets.filter((t) => SESSION_ROUTE.test(pathOf(t).slice(1))), 'a control that goes to a sign-in route').toEqual([]);
      expect(Array.from(main!.querySelectorAll('form')).filter((f) => (f.getAttribute('method') ?? 'get').toLowerCase() !== 'get')).toEqual([]);
      expect(main!.querySelectorAll('input[type="password"]')).toHaveLength(0);
    } finally {
      page.close();
    }
  });

  it("verify.js never reads the session", () => {
    const src = readFileSync(join(repoRoot, 'src/web/public/js/pages/verify.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/sessionStorage|localStorage|getStoredSession|fa_session|\/auth\/|\/signin|accounts\/me/);
  });
});

function arrivalText(main: Element): string {
  const copy = main.cloneNode(true) as Element;
  copy.querySelectorAll('.detail, [hidden], script, style, template').forEach((el) => el.remove());
  return copy.textContent ?? '';
}

// ------------------------------------------------------------- laid out right

// Every control a person can reach in <main>, at the width under test:
// links, buttons and every field a person types into or picks from (the
// lookup field included). A link inside a sentence is exempt (WCAG 2.5.8),
// the rule S1 and S2 use.
// The floor carries 0.05px of slack for float noise; the planted control
// below proves 43px and 43.9px are still caught.
const TAP_FLOOR = 43.95;
const SWEEP = `
  (function () {
    function inSentence(a) {
      return [].some.call(a.parentElement.childNodes, function (n) {
        return n.nodeType === 3 && n.textContent.trim().length > 0;
      });
    }
    var doc = document.documentElement;
    var all = [].filter.call(document.querySelectorAll('main a[href], main button, main input:not([type="hidden"]), main select, main textarea'), function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      past: [].filter.call(document.querySelectorAll('main *'), function (el) {
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= doc.clientWidth + 0.5) return false;
        for (var p = el.parentElement; p; p = p.parentElement) {
          var ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') {
            if (p.getBoundingClientRect().right <= doc.clientWidth + 0.5) return false;
          }
        }
        return true;
      }).slice(0, 6).map(function (el) { return el.tagName + '#' + el.id + '.' + el.className; }),
      measured: all.length,
      small: all.filter(function (el) {
        var r = el.getBoundingClientRect();
        return (r.width < ${TAP_FLOOR} || r.height < ${TAP_FLOOR}) && !(el.tagName === 'A' && inSentence(el));
      }).map(function (el) {
        var r = el.getBoundingClientRect();
        return (el.id || el.className || el.tagName) + ' "' + el.textContent.trim().slice(0, 30) + '" ' + r.width + 'x' + r.height;
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

const captureDir = process.env.S3_CAPTURE_DIR ?? '';

async function capture(browser: RealBrowser, name: string): Promise<void> {
  if (captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  // base.css holds every .reveal at opacity 0 until it intersects, so walk
  // the page first or a full-page capture shows empty bands.
  await browser.evaluate(`(async function () { for (var y = 0; y < document.documentElement.scrollHeight; y += 300) { scrollTo(0, y); await new Promise(function (r) { setTimeout(r, 60); }); } scrollTo(0, 0); })()`);
  await new Promise((r) => setTimeout(r, 900));
  const metrics = (await browser.send('Page.getLayoutMetrics')) as { result?: { cssContentSize?: { height: number } } };
  const height = Math.ceil(metrics.result?.cssContentSize?.height ?? 900);
  const shot = (await browser.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: await browser.evaluate<number>('document.documentElement.clientWidth'), height, scale: 1 },
  })) as { result?: { data?: string } };
  if (shot.result?.data) writeFileSync(join(captureDir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
}

async function openAt(width: number, path: string, ready: string): Promise<RealBrowser> {
  const browser = await RealBrowser.launch({ width, height: 900 });
  if (width === 320) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 2, mobile: true });
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  await browser.goto(`${baseUrl}${path}`, 400);
  const deadline = Date.now() + 10_000;
  while (!(await browser.evaluate<boolean>(`!!(${ready})`))) {
    if (Date.now() > deadline) {
      await browser.close();
      throw new Error(`${path} never reached its state`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 700));
  return browser;
}

describe('(h) laid out right at 1280 and 320, in each state, each disclosure open in turn', () => {
  const LAYOUT: ReadonlyArray<readonly [string, string, string]> = [
    ['lookup', '/verify', "!document.getElementById('lookup').hidden"],
    ['failed', verifyPath(MISSING), "!document.getElementById('load-error').hidden"],
    ['loaded', verifyPath(HIRE.id), `!document.getElementById('loaded').hidden && (document.querySelector('#claim b') || {}).textContent === ${JSON.stringify(AGENT_NAME)}`],
  ];
  const PANELS = ['sigcheck', 'ghcheck', 'idcheck'];

  for (const width of [1280, 320]) {
    it.each(LAYOUT)(`${width}px: %s`, async (label, path, ready) => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for the verify layout sweep; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await openAt(width, path, ready);
      try {
        for (const state of ['closed', ...PANELS]) {
          if (state !== 'closed') {
            await browser.evaluate(`document.querySelector('main .disclose[data-disclose="${state}"]').click()`);
            await new Promise((r) => setTimeout(r, 300));
            const open = await browser.evaluate<string[]>(
              `[].filter.call(document.querySelectorAll('main .detail'), function (d) { return d.getBoundingClientRect().height > 0; }).map(function (d) { return d.id; })`,
            );
            expect(open, `${label}: opening ${state} opened something else`).toEqual([state]);
          }
          const s = await browser.evaluate<Sweep>(SWEEP);
          expect(s.measured, `${label} ${state}: nothing to measure, the page did not render its <main>`).toBeGreaterThan(3);
          expect(s.past, `${label} at ${width}, ${state}: past the right edge`).toEqual([]);
          expect(s.scrollWidth, `${label} at ${width}, ${state}: sideways scroll`).toBe(s.clientWidth);
          expect(s.small, `${label} at ${width}, ${state}: under 44px`).toEqual([]);
          await capture(browser, `verify-${label}-${width}-${state}`);
          if (state !== 'closed') {
            await browser.evaluate(`document.querySelector('main .disclose[data-disclose="${state}"]').click()`);
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);
  }

  it.each([1280, 320])('%ipx: the agent row with its new link', async (width) => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the agent row sweep; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await openAt(width, agentPath(AGENT_DID), "document.querySelector('#summary:not([data-pending])')");
    try {
      await browser.evaluate(`document.querySelector('[aria-controls="tab-work"]').click()`);
      await new Promise((r) => setTimeout(r, 300));
      const link = await browser.evaluate<{ w: number; h: number; text: string } | null>(`(function () {
        var a = document.querySelector('#history a.verify[href^="/verify"]');
        if (!a) return null;
        var r = a.getBoundingClientRect();
        return { w: r.width, h: r.height, text: a.textContent.trim() };
      })()`);
      expect(link, 'the new link is not on the verified-hire row').not.toBeNull();
      expect(link!.text).toBe('Check this yourself');
      expect(link!.h, 'the new link is under 44px tall').toBeGreaterThanOrEqual(TAP_FLOOR);
      expect(link!.w, 'the new link is under 44px wide').toBeGreaterThanOrEqual(TAP_FLOOR);
      const s = await browser.evaluate<Sweep>(SWEEP);
      expect(s.scrollWidth, `agent at ${width}: sideways scroll`).toBe(s.clientWidth);
      expect(s.past).toEqual([]);
      if (captureDir !== '') {
        await browser.evaluate(`document.querySelector('#history').scrollIntoView({ block: 'center' })`);
        await new Promise((r) => setTimeout(r, 600));
        const shot = (await browser.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
        mkdirSync(captureDir, { recursive: true });
        if (shot.result?.data) writeFileSync(join(captureDir, `agent-row-${width}.png`), Buffer.from(shot.result.data, 'base64'));
      }
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);

  // The gate's own control: three buttons and two text fields planted in the
  // real page at 320 with touch on. 43px, 43.9px and a 40px field must be
  // named, the 44px button and the 44px field must not, and nothing else on
  // the page may be named.
  it('the 44px sweep names a planted 43px and 43.9px button and a 40px field, and passes 44px ones', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for the 44px sweep control; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await openAt(320, '/verify', "!document.getElementById('lookup').hidden");
    try {
      await browser.evaluate(`(function () {
        var main = document.querySelector('main');
        [['plant-43', 43], ['plant-43-9', 43.9], ['plant-44', 44]].forEach(function (p) {
          var b = document.createElement('button');
          b.id = p[0];
          b.textContent = p[0];
          b.style.cssText = 'all: unset; display: block; box-sizing: border-box; width: 100px; height: ' + p[1] + 'px;';
          main.appendChild(b);
        });
        [['plant-field-40', 40], ['plant-field-44', 44]].forEach(function (p) {
          var i = document.createElement('input');
          i.id = p[0];
          i.type = 'text';
          i.style.cssText = 'all: unset; display: block; box-sizing: border-box; width: 200px; height: ' + p[1] + 'px;';
          main.appendChild(i);
        });
      })()`);
      const s = await browser.evaluate<Sweep>(SWEEP);
      expect(s.small.map((line) => line.split(' ')[0])).toEqual(['plant-43', 'plant-43-9', 'plant-field-40']);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
