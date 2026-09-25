// S2: the past-work pages, simple. The agent profile and the receipt a
// person reads to judge an agent's past work, taken to the landing page's
// level of simple, the same way S1 took the hire journey there. What that
// promises is pinned here as rules rather than as copy:
//
//   a word ceiling       agent.html ships at most 180 words (40% of 451),
//                        the receipt at most 100 (47% of 211), and what a
//                        person meets on landing on the agent page (hidden
//                        tab panels and technical details removed) at most
//                        120, counted by the card's static_words.py rule
//                        inside exactly one <main>
//   one primary action   exactly one primary button in every loaded state,
//                        none on a not-found page
//   the record leads     the name, the record sentence and three counts,
//                        in that order, then the tabs; the evidence rules of
//                        MISSION invariants 4 and 5 hold as before
//   no machine words     no DID, job id, merge commit, key or S1 jargon word
//                        on the surface of either page; they sit behind
//                        "Show technical details" or in the receipt's
//                        technical half, every one still reachable
//   rows that say        nothing that reads "not yet observed" for every
//   something            agent ships
//   one step list        no four-step How it works tab; the link goes to
//                        the landing page's five steps
//   the detail moved     every link that replaced a paragraph names what is
//                        behind it and lands on something that exists
//   laid out right       at 1280 and 320 in real Chrome: no sideways
//                        scroll, every control 44px or more at 320, each
//                        tab selected and each disclosure opened
//
// The other tests that guard these pages (agent-cold-start, agent-freshness,
// agent-gallery, agent-reviews, agent-work-history-tabs, credential-polished,
// credential-wireframe, render, mobile-layout, league-look,
// wireframe-conformance) still run against them.
//
// Set S2_CAPTURE_DIR to a directory to have the layout sweep also save a
// full-page screenshot of each state at both widths. Off by default.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCompromiseRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryReviewRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import type { Job } from '../../src/domain/job.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { agentPageReady, receiptPageReady, settled } from '../helpers/page-settled.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../..');
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const BROWSER_TIMEOUT_MS = 90_000;

// ------------------------------------------------------------ the ceilings

// The count each page shipped before S2 (origin/main at a16de36), by the
// card's static_words.py. Neither page had a <main> then, so each count was
// the whole file's.
const BEFORE = { agent: 451, credential: 211 } as const;
const CEILING = { agent: 180, credential: 100 } as const;
const ARRIVAL_CEILING = 120;

// static_words.py, ported line for line (the same port S1's test carries):
// <main> to </main>, then script, style and template blocks out, then
// comments out, then tags to spaces, then entities decoded, then split on
// whitespace. Hidden state panels count: they are copy the page ships.
function staticWords(src: string): string[] {
  const m = src.match(/<main[\s\S]*?<\/main>/);
  let body = m ? m[0] : src;
  body = body.replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/g, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  const text = body.replace(/<[^>]+>/g, ' ');
  const decoded = new JSDOM(`<p>${text.replace(/</g, '&lt;')}</p>`).window.document.body.textContent ?? '';
  return decoded.split(/\s+/).filter(Boolean);
}

// The arrival view: what a person meets on landing. <main> with every tab
// panel that ships hidden and every .detail removed, then counted by the
// same rule. Parsed, not regexed, so a nested div cannot end a cut early.
function arrivalWords(src: string): string[] {
  const doc = new JSDOM(src).window.document;
  const main = doc.querySelector('main');
  if (main === null) return staticWords(src);
  main.querySelectorAll('[role="tabpanel"][hidden], .detail').forEach((el) => el.remove());
  return staticWords(main.outerHTML);
}

const pageSource = (page: string): string => readFileSync(join(repoRoot, 'src/web/pages', `${page}.html`), 'utf8');

describe('(a) the counter itself', () => {
  it('agrees with static_words.py on a known input', () => {
    // A comment that quotes a tag, a script, an entity and a template must
    // all be handled the way the script does.
    const src = '<nav>Nav words</nav><main><!-- a <b>note</b> --><h1>One&nbsp;two</h1><script>var x = "no";</script><template><p>no</p></template><p>three &amp; four</p></main>';
    expect(staticWords(src)).toEqual(['One', 'two', 'three', '&', 'four']);
  });

  it('the arrival view drops hidden tab panels and details, and nothing else', () => {
    const src =
      '<main><h1>Name here</h1><div role="tabpanel" id="a">shown panel</div><div role="tabpanel" hidden><div><p>hidden panel</p></div></div>' +
      '<button class="disclose">Show more</button><div class="detail"><div>behind a click</div></div><p>after</p></main>';
    expect(arrivalWords(src)).toEqual(['Name', 'here', 'shown', 'panel', 'Show', 'more', 'after']);
  });
});

describe('(a) each page is at or under its word ceiling', () => {
  it.each(Object.keys(BEFORE) as Array<keyof typeof BEFORE>)('%s', (page) => {
    const words = staticWords(pageSource(page));
    expect(words.length, `${page}: ${words.length} words, ceiling ${CEILING[page]}. The copy: ${words.join(' ')}`).toBeLessThanOrEqual(
      CEILING[page],
    );
  });

  it('the agent page as a person lands on it', () => {
    const words = arrivalWords(pageSource('agent'));
    expect(words.length, `agent arrival: ${words.length} words, ceiling ${ARRIVAL_CEILING}. The copy: ${words.join(' ')}`).toBeLessThanOrEqual(
      ARRIVAL_CEILING,
    );
  });
});

describe('(b) exactly one <main> per page, between the nav and the footer', () => {
  it.each(['agent', 'credential'])('%s', (page) => {
    const src = pageSource(page);
    expect(src.match(/<main\b/g)?.length ?? 0, `${page} must have exactly one <main>, or the count reads the whole file`).toBe(1);
    const doc = new JSDOM(src).window.document;
    const main = doc.querySelector('main')!;
    const nav = doc.querySelector('nav.nav')!;
    const foot = doc.querySelector('footer.foot')!;
    expect(Boolean(nav.compareDocumentPosition(main) & 0x04), 'the nav comes before <main>').toBe(true);
    expect(Boolean(main.compareDocumentPosition(foot) & 0x04), '<main> comes before the footer').toBe(true);
    expect(main.contains(nav) || main.contains(foot), 'the nav and footer stay outside <main>').toBe(false);
  });
});

// ------------------------------------------------------------ the fixtures

const OPERATOR_DID = 'did:abt:zS2PastWorkOperator';
const OPERATOR_LOGIN = 's2-past-work-operator';
const AGENT_DID = 'did:abt:zS2PastWorkAgent';
const AGENT_NAME = 's2-past-work-scout';
const BUYER_DID = 'did:abt:zS2PastWorkBuyer';
const COLD_OPERATOR_DID = 'did:abt:zS2ColdOperator';
const COLD_DID = 'did:abt:zS2ColdAgent';
const COLD_NAME = 's2-cold-agent';
const REVIEW_TEXT = 'Clear updates, and the checkout works.';

// One job per tier and state the page can render: a verified hire, a
// self-hire (the buyer is the operator, R-33) that is also verified, and a
// portfolio claim (a merge into a private repository demotes to the claim
// tier, invariant 4). No prior-work item can reach GET /agents/:did (ENT-11
// is not wired, src/domain/agent-work-record.ts), so its zero state is what
// every fixture shows.
const HIRE = { id: 's2-job-hire', repository: 'buyer/s2-shop', mergeCommit: 's2mergehire0001', buyer: BUYER_DID, public: true };
const SELF = { id: 's2-job-self', repository: 'operator/s2-own-site', mergeCommit: 's2mergeself0002', buyer: OPERATOR_DID, public: true };
const CLAIM = { id: 's2-job-claim', repository: 'buyer/s2-private', mergeCommit: 's2mergeclaim003', buyer: BUYER_DID, public: false };
const JOBS = [HIRE, SELF, CLAIM];
const MERGED_AT = '2026-09-10T00:00:00.000Z';
const SIGNING_KEY = `${AGENT_DID}#key-1`;
const NEXT_KEY = `${AGENT_DID}#key-2`;

// Every exact identifier the fixtures put into the record. The machine-word
// gate checks for each of these by value on the surface.
const IDENTITIES = [AGENT_DID, OPERATOR_DID, BUYER_DID, COLD_DID, COLD_OPERATOR_DID];
const EXACT_VALUES = [...JOBS.map((j) => j.id), ...JOBS.map((j) => j.mergeCommit), SIGNING_KEY, NEXT_KEY];

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:s2-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-01T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-01T00:00:00.000Z',
      verificationMethod: `${operatorDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zS2FixtureNotVerifiedHere',
    },
  };
}

function credentialDoc(job: (typeof JOBS)[number]): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://platform.example/v1/credentials/${job.id}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: MERGED_AT,
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:s2-brief',
        repository: job.repository,
        pullRequest: `https://github.com/${job.repository}/pull/3`,
        mergedAt: MERGED_AT,
        mergeCommit: job.mergeCommit,
        signedBy: SIGNING_KEY,
        buyer: job.buyer,
        additions: 40,
        deletions: 6,
        filesChanged: 3,
        specHash: 'sha256:s2-spec',
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zS2Proof' },
  };
}

function jobFixture(id: string, buyerDid: string, repository: string): Job {
  return {
    id,
    agentDid: AGENT_DID,
    buyerDid,
    repository,
    brief: 'Make the checkout keep its cart.',
    briefHash: 'sha256:s2-brief',
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
  const compromiseRepo = new MemoryCompromiseRepository();
  const reviewRepo = new MemoryReviewRepository();

  await accountRepo.register({ did: OPERATOR_DID, githubLogin: OPERATOR_LOGIN });
  await accountRepo.register({ did: BUYER_DID, githubLogin: 's2-past-work-buyer' });
  // The fallback: an operator whose account carries no GitHub login.
  await accountRepo.register({ did: COLD_OPERATOR_DID });

  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_DID, OPERATOR_DID),
    name: AGENT_NAME,
    skills: ['websites'],
    githubLogin: null,
  });
  await agentRepo.create({
    did: COLD_DID,
    operatorDid: COLD_OPERATOR_DID,
    delegation: delegation(COLD_DID, COLD_OPERATOR_DID),
    name: COLD_NAME,
    skills: [],
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

  // A replaced key (ENT-8.4) and a reported compromise whose window covers
  // every receipt above (R-16): since is before MERGED_AT, and the storage
  // stamps reportedAt now.
  await agentRepo.recordKeyRotation(AGENT_DID, { fromKey: SIGNING_KEY, toKey: NEXT_KEY });
  await compromiseRepo.record(AGENT_DID, { key: SIGNING_KEY, since: new Date('2026-09-05T00:00:00Z') });

  await reviewRepo.save({ jobId: HIRE.id, authorDid: BUYER_DID, agentDid: AGENT_DID, text: REVIEW_TEXT, createdAt: new Date('2026-09-11T00:00:00Z') });

  server = createApp(
    accountRepo,
    agentRepo,
    undefined,
    undefined,
    jobRepo,
    undefined,
    compromiseRepo,
    credentialRepo,
    undefined,
    undefined,
    reviewRepo,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const agentPath = (did: string): string => `/agents/${encodeURIComponent(did)}`;
const receiptPath = (id: string): string => `/v1/credentials/${id}`;

// The page with its own scripts run for real, settled on the signal the
// page itself sets when its reads are done (tests/helpers/page-settled.ts).
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
  const doc = dom.window.document;
  if (path.startsWith('/agents/')) {
    await settled(doc, agentPageReady, path);
    // The operator line fills from a second read after the record.
    await settled(doc, (d) => !(d.getElementById('operated-by') as HTMLElement).hidden || !(d.getElementById('load-error') as HTMLElement).hidden, `${path} operator line`);
  } else {
    await settled(doc, receiptPageReady, path);
    // The agent's name and the dispute marker arrive from two more reads.
    await settled(
      doc,
      (d) => !(d.getElementById('load-error') as HTMLElement).hidden || d.getElementById('fact-agent')?.textContent === AGENT_NAME,
      `${path} agent name`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const real = failures.filter((m) => !m.includes('Not implemented'));
  if (real.length > 0) throw new Error(`page script failed on ${path}: ${real.join('; ')}`);
  return { document: doc, close: () => dom.window.close() };
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

// ------------------------------------------------------------- no jargon

// S1's list (tests/web/hire-journey-simple.test.ts JARGON and JARGON_EXACT)
// plus "hashed", matched as whole words; DID case-sensitive so the English
// word "did" passes. A DID written out in any form, and every exact value
// the fixtures put into the record (identities, job ids, merge commits,
// keys), is checked by value as well.
const JARGON = ['credential', 'credentials', 'attestation', 'attested', 'hash', 'hashes', 'hashed', 'Ed25519', 'settlement', 'settle', 'settles', 'settled', 'rail', 'rails', 'specHash', 'diffHash'];
const JARGON_EXACT = ['DID', 'DIDs'];
const DID_STRING = /\bdid:[a-z0-9]+:/i;

function machineWords(text: string): string[] {
  const found = [
    ...JARGON.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text)),
    ...JARGON_EXACT.filter((w) => new RegExp(`\\b${w}\\b`).test(text)),
  ];
  const did = DID_STRING.exec(text);
  if (did) found.push(`a DID string at "${squash(text.slice(Math.max(0, did.index - 20), did.index + 30))}"`);
  for (const id of IDENTITIES) {
    const suffix = id.replace(/^did:[a-z0-9]+:/i, '');
    if (text.includes(id) || text.includes(suffix)) found.push(`the identity ${id}`);
  }
  for (const value of EXACT_VALUES) {
    if (text.includes(value) || text.includes(value.slice(0, 12))) found.push(`the exact value ${value}`);
  }
  return found;
}

describe('(c) the machine-word gate itself', () => {
  // Its own control: it says no to each kind of exact term and yes to the
  // same line in plain words.
  it.each([
    ['operated by did:abt:zS2PastWorkOperator', true],
    ['operated by did:abt:zS2PastWo\u2026erator', true],
    ['by zS2PastWorkBuyer', true],
    ['job s2-job-hire', true],
    ['merge s2mergehire0', true],
    [`${SIGNING_KEY} \u2192 ${NEXT_KEY}`, true],
    ['The agreed spec is hashed, so it cannot change.', true],
    ['Verify this credential', true],
    ['operated by @s2-past-work-operator', false],
    ['See the receipt', false],
    ['The agent did the work.', false],
    ['This agent replaced a signing key on 25 September 2026.', false],
  ] as const)('%s', (text, caught) => {
    expect(machineWords(text).length > 0, JSON.stringify(machineWords(text))).toBe(caught);
  });
});

// Every state each page renders from the fixtures. The agent page's hidden
// tab panels stay in: they are one click from the surface, not behind
// "Show technical details".
const AGENT_STATES: ReadonlyArray<readonly [string, string]> = [
  ['agent with a record, a self-hire, a claim, a review, a key change and a reported compromise', agentPath(AGENT_DID)],
  ['agent with no record, whose operator has no GitHub login', agentPath(COLD_DID)],
  ['agent not found', agentPath('did:abt:zS2NobodyAtAll')],
];
const RECEIPT_STATES: ReadonlyArray<readonly [string, string]> = [
  ['receipt, disputed by the reported compromise', receiptPath(HIRE.id)],
  ['receipt, self-hire', receiptPath(SELF.id)],
  ['receipt not found', receiptPath('s2-no-such-receipt')],
];

describe('(c) no machine words on the surface of either page', () => {
  it.each([...AGENT_STATES, ...RECEIPT_STATES])('%s', async (_label, path) => {
    const page = await render(path);
    try {
      const doc = page.document;
      const main = doc.querySelector('main');
      doc.querySelectorAll('.detail, script, style, nav, footer, template').forEach((el) => el.remove());
      const text = (main ?? doc.body).textContent ?? '';
      expect(machineWords(text), `on the surface of ${path}`).toEqual([]);
      expect(main, 'the surface is <main>').not.toBeNull();
    } finally {
      page.close();
    }
  });
});

describe('invariant 2: every exact term is still reachable, copyable, behind one click', () => {
  it('agent: its identity, its operator and where its receipts resolve', async () => {
    const page = await render(agentPath(AGENT_DID));
    try {
      const d = page.document;
      const rows: Array<[string, string]> = [
        ['tech-did', AGENT_DID],
        ['tech-operator', OPERATOR_DID],
        ['tech-credentials', `${baseUrl}/agents/${encodeURIComponent(AGENT_DID)}/credentials`],
      ];
      for (const [id, value] of rows) {
        const cell = d.getElementById(id)!;
        expect(cell.closest('.detail'), `#${id} is not behind "Show technical details"`).not.toBeNull();
        expect(cell.textContent).toBe(value);
        expect(d.getElementById(`${id}-copy`)?.getAttribute('data-copy'), `#${id}-copy copies something else`).toBe(value);
      }
      // The receipts address is real: it answers without a session.
      const creds = await fetch(`${baseUrl}/agents/${encodeURIComponent(AGENT_DID)}/credentials`);
      expect(creds.status).toBe(200);
      // The keys named by the two key lists, in full, one click away.
      const keys = d.getElementById('tech-keys')!;
      expect(keys.closest('.detail')).not.toBeNull();
      expect((d.getElementById('tech-keys-wrap') as HTMLElement).hidden).toBe(false);
      expect(keys.textContent).toContain(`${SIGNING_KEY} \u2192 ${NEXT_KEY}`);
      expect(keys.textContent).toContain(`Reported compromised: ${SIGNING_KEY}`);
      // The header names the operator in words and links to their page.
      expect(squash(d.getElementById('operated-by')?.textContent)).toBe(`operated by @${OPERATOR_LOGIN}`);
      expect(d.getElementById('operator-link')?.getAttribute('href')).toBe(`/accounts/${encodeURIComponent(OPERATOR_DID)}`);
    } finally {
      page.close();
    }
  });

  it('agent whose operator has no GitHub login: still named in words, still linked', async () => {
    const page = await render(agentPath(COLD_DID));
    try {
      const d = page.document;
      expect(squash(d.getElementById('operated-by')?.textContent)).toBe('See who runs this agent');
      expect(d.getElementById('operator-link')?.getAttribute('href')).toBe(`/accounts/${encodeURIComponent(COLD_OPERATOR_DID)}`);
      expect(d.getElementById('tech-operator')?.textContent).toBe(COLD_OPERATOR_DID);
      expect((d.getElementById('tech-keys-wrap') as HTMLElement).hidden, 'a key row with no keys').toBe(true);
    } finally {
      page.close();
    }
  });

  it('receipt: both identities, the issuer, the signing key, both fingerprints and the raw document', async () => {
    const page = await render(receiptPath(HIRE.id));
    try {
      const d = page.document;
      const doc = credentialDoc(HIRE);
      const hire = doc.credentialSubject.hire as unknown as Record<string, string>;
      const rows: Array<[string, string]> = [
        ['id-agent', AGENT_DID],
        ['id-buyer', BUYER_DID],
        ['id-issuer', 'did:abt:platform'],
        ['id-signer', SIGNING_KEY],
        ['agreed-brief', hire.brief!],
        ['agreed-spec', hire.specHash!],
      ];
      for (const [id, value] of rows) {
        const cell = d.getElementById(id)!;
        expect(cell.closest('.detail'), `#${id} is not in the technical half`).not.toBeNull();
        expect(cell.textContent).toBe(value);
        expect(d.getElementById(`${id}-copy`)?.getAttribute('data-copy')).toBe(value);
      }
      expect(JSON.parse(d.getElementById('raw-json')?.textContent ?? '{}')).toEqual(doc);
      expect(d.getElementById('raw-download-link')?.getAttribute('href')).toBe(receiptPath(HIRE.id));
      expect(d.getElementById('raw-verify-link')?.getAttribute('href')).toBe(`/verify?credential=${HIRE.id}`);
      // The receipt names the agent from its record, never its DID.
      expect(d.getElementById('fact-agent')?.textContent).toBe(AGENT_NAME);
      expect(d.getElementById('fact-agent')?.querySelector('a')?.getAttribute('href')).toBe(agentPath(AGENT_DID));
      expect(squash(d.getElementById('claim')?.textContent)).toMatch(new RegExp(`^${AGENT_NAME} shipped work to ${HIRE.repository}, and it merged on `));
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------- the record leads

const before = (a: Element, b: Element): boolean => Boolean(a.compareDocumentPosition(b) & 0x04);

describe('(d) the record leads, and the evidence rules hold (MISSION invariants 4 and 5)', () => {
  it('with a record: name, sentence, three counts in order, then the tabs', async () => {
    const page = await render(agentPath(AGENT_DID));
    try {
      const d = page.document;
      const main = d.querySelector('main');
      expect(main, 'no <main>').not.toBeNull();
      const name = d.getElementById('name')!;
      const summary = d.getElementById('summary')!;
      const stats = d.querySelector('main .pstats')!;
      const tabs = d.querySelector('main [role="tablist"]')!;
      expect(name.textContent).toBe(AGENT_NAME);
      expect(before(name, summary) && before(summary, stats) && before(stats, tabs), 'name, sentence, counts, tabs is not the order').toBe(true);
      // Nothing else sits in the header block: the identity box folded
      // into the technical details.
      expect(d.getElementById('ident'), 'the identity box is back above the tabs').toBeNull();

      // The record sentence, and the self-hire counted beside it (R-33).
      expect(summary.textContent).toBe('2 verified hires, from 2 separate buyers.');
      const selfLine = d.getElementById('selfhires') as HTMLElement;
      expect(selfLine.hidden).toBe(false);
      expect(selfLine.textContent).toBe('Of those, 1 hire was placed by its own operator, labelled on the row.');

      // Three cells, in the one order, never summed; jade only above zero.
      const cells = Array.from(stats.querySelectorAll('.pstat'));
      expect(cells.map((c) => squash(c.querySelector('.k')?.textContent))).toEqual(['Verified hires', 'Verified prior work', 'Portfolio claims']);
      expect(cells.map((c) => c.querySelector('.v')?.textContent)).toEqual(['2', '0', '1']);
      expect(cells[0]!.classList.contains('is-zero'), 'a checked count painted grey').toBe(false);

      // Three sections in order, each present; prior work shows its zero.
      const headings = ['tier-hire-heading', 'tier-prior-heading', 'tier-claim-heading'].map((id) => d.getElementById(id)!);
      expect(before(headings[0]!, headings[1]!) && before(headings[1]!, headings[2]!)).toBe(true);
      expect(d.getElementById('history')?.children.length).toBe(2);
      expect((d.getElementById('prior-work-empty') as HTMLElement).hidden).toBe(false);
      expect(d.getElementById('portfolio')?.children.length).toBe(1);

      // Verified rows link to their receipt; the self-hire row says so.
      const hireRows = Array.from(d.getElementById('history')!.children);
      expect(hireRows.map((r) => r.querySelector('.verify')?.getAttribute('href')).sort()).toEqual(
        [receiptPath(HIRE.id), receiptPath(SELF.id)].sort(),
      );
      const selfRow = hireRows.find((r) => r.querySelector('.verify')?.getAttribute('href') === receiptPath(SELF.id))!;
      expect(selfRow.querySelector('.selflabel')?.textContent).toBe('hired by its own operator');
      expect(hireRows.find((r) => r !== selfRow)!.querySelector('.selflabel')).toBeNull();

      // A claim never gets a check link, and says it cannot be checked, in
      // the rows and in the gallery.
      const claimRow = d.getElementById('portfolio')!.firstElementChild!;
      expect(claimRow.querySelector('.verify')).toBeNull();
      expect(claimRow.textContent).toContain('We cannot check this.');
      const claimCard = d.querySelector('#gallery figure.work.is-claim')!;
      expect(claimCard.querySelectorAll('a')).toHaveLength(0);
      expect(claimCard.textContent).toContain('We have not seen this work.');

      // Reviews are the buyer's opinion, not verification (R-22).
      const reviews = d.getElementById('tab-reviews')!;
      expect(squash(reviews.querySelector('.sub')?.textContent)).toBe("The buyer's own opinion, not verification.");
      expect(reviews.textContent).toContain(REVIEW_TEXT);
      expect(reviews.textContent).toContain('from the buyer who hired it');

      // A reported key compromise is shown with its window, a key change
      // with its date (R-16, ENT-8.4), both on the surface.
      const compromise = d.getElementById('compromise-wrap') as HTMLElement;
      expect(reachable(compromise), 'the compromise window is hidden').toBe(true);
      expect(squash(compromise.textContent)).toMatch(/A key was reported compromised, covering work signed from .+ onward\.\s*Reported on .+\./);
      expect(reachable(d.getElementById('rotations-wrap')!)).toBe(true);
      expect(squash(d.getElementById('rotations')?.textContent)).toMatch(/^This agent replaced a signing key on .+\.\s*Receipts signed with the old key still check out\.$/);

      // The freshness dates stay reachable (R-37).
      for (const id of ['tech-created', 'tech-record-changed', 'tech-last-hire']) {
        const cell = d.getElementById(id)!;
        expect(cell.closest('.detail')).not.toBeNull();
        expect(cell.textContent, `#${id}`).not.toBe('');
        expect(cell.textContent, `#${id}`).not.toBe('not recorded');
      }
    } finally {
      page.close();
    }
  });

  it('with no record: the same shape, each section showing its own zero state', async () => {
    const page = await render(agentPath(COLD_DID));
    try {
      const d = page.document;
      expect(d.querySelector('main'), 'no <main>').not.toBeNull();
      expect(d.getElementById('ident'), 'the identity box is back above the tabs').toBeNull();
      expect(d.getElementById('summary')?.textContent).toBe('0 verified hires, from no buyers yet.');
      const cells = Array.from(d.querySelectorAll('main .pstats .pstat'));
      expect(cells.map((c) => c.querySelector('.v')?.textContent)).toEqual(['0', '0', '0']);
      expect(cells[0]!.classList.contains('is-zero'), 'a zero painted jade').toBe(true);
      const empties: Array<[string, string]> = [
        ['history-empty', 'No verified hires yet.'],
        ['prior-work-empty', 'No verified prior work.'],
        ['portfolio-empty', 'No portfolio claims.'],
        ['reviews-empty', 'No reviews yet.'],
        ['gallery-empty', 'Nothing to show yet.'],
      ];
      for (const [id, words] of empties) {
        const el = d.getElementById(id) as HTMLElement;
        expect(el.hidden, `#${id} is hidden`).toBe(false);
        expect(squash(el.textContent), `#${id}`).toContain(words);
      }
      expect((d.getElementById('selfhires') as HTMLElement).hidden).toBe(true);
      expect((d.getElementById('compromise-wrap') as HTMLElement).hidden).toBe(true);
      expect(d.getElementById('tech-last-hire')?.textContent).toBe('not recorded');
    } finally {
      page.close();
    }
  });
});

// ----------------------------------------------- rows that state nothing

describe('rows that say "not yet observed" for every agent do not ship (target 5)', () => {
  it.each([
    ['source', null],
    ['rendered, with a record', agentPath(AGENT_DID)],
  ] as const)('%s', async (_label, path) => {
    const doc = path === null ? new JSDOM(pageSource('agent')).window.document : (await render(path)).document;
    expect(doc.body.textContent ?? '').not.toContain('not yet observed');
    for (const label of ['Merge rate', 'Typical change', 'Median time to PR', 'Languages seen', 'What it works on']) {
      expect(doc.body.textContent ?? '', label).not.toContain(label);
    }
  });
});

// --------------------------------------------------------- one step list

describe('one list of hire steps (target 6)', () => {
  it('no four-step tab ships, and the link to the steps lands on the landing page\u2019s five', async () => {
    const doc = new JSDOM(pageSource('agent')).window.document;
    expect(doc.getElementById('tab-how'), 'the How it works tab panel is back').toBeNull();
    expect(doc.querySelector('[aria-controls="tab-how"]')).toBeNull();
    expect(doc.querySelector('.howlist, ol li b')).toBeNull();
    expect(pageSource('agent')).not.toMatch(/\bhashed\b/);

    const stepsLink = Array.from(doc.querySelectorAll('main a.sf-more')).find((a) => /how a hire works/i.test(a.textContent ?? ''));
    expect(stepsLink, 'no link to the hire steps').toBeDefined();
    const [path, hash] = stepsLink!.getAttribute('href')!.split('#');
    const res = await fetch(`${baseUrl}${path || '/'}`, { headers: { Accept: HTML } });
    expect(res.status).toBe(200);
    const target = new JSDOM(await res.text()).window.document.getElementById(hash ?? '');
    expect(target, `no #${hash} on ${path || '/'}`).not.toBeNull();
    // What is behind the link is the one list: stepflow.js HIRE_STEPS.
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(readFileSync(join(repoRoot, 'src/web/public/js/stepflow.js'), 'utf8'));
    const steps = (dom.window as unknown as { FAStepflow: { HIRE_STEPS: Array<{ label: string }> } }).FAStepflow.HIRE_STEPS;
    const labels = Array.from(target!.querySelectorAll('.sf-label')).map((el) => squash(el.textContent));
    expect(labels).toEqual(steps.map((s) => s.label));
  });
});

// ----------------------------------------------------- the detail moved

describe('every link that replaced a paragraph names what is behind it and lands on it (target 7)', () => {
  it('each .sf-more link on the agent page', async () => {
    const doc = new JSDOM(pageSource('agent')).window.document;
    const links = Array.from(doc.querySelectorAll('main a.sf-more'));
    expect(links.length, 'no moved-detail links: the selector broke').toBeGreaterThanOrEqual(2);
    for (const a of links) {
      const words = squash(a.textContent);
      const href = a.getAttribute('href') ?? '';
      expect(words.split(' ').length, `"${words}" is too vague to say what is behind it`).toBeGreaterThanOrEqual(4);
      const [path, hash] = href.split('#');
      const res = await fetch(`${baseUrl}${path || '/'}`, { headers: { Accept: HTML } });
      expect(res.status, `${words} -> ${href}`).toBe(200);
      if (hash) expect(new JSDOM(await res.text()).window.document.getElementById(hash), `${words} -> ${href}`).not.toBeNull();
    }
  });
});

// ------------------------------------------------------ one primary action

const TABS = ['tab-portfolio', 'tab-work', 'tab-reviews'];

describe('(e) exactly one primary button in every loaded state, none on a not-found page', () => {
  const states: ReadonlyArray<readonly [string, string, number]> = [
    ...AGENT_STATES.map(([label, path]) => [label, path, label.includes('not found') ? 0 : 1] as const),
    ...RECEIPT_STATES.map(([label, path]) => [label, path, label.includes('not found') ? 0 : 1] as const),
  ];
  it.each(states)('%s', async (_label, path, expected) => {
    const page = await render(path);
    try {
      const d = page.document;
      const views: string[] = d.getElementById('tab-portfolio') ? TABS : ['page'];
      for (const view of views) {
        if (view !== 'page') {
          // Select this tab the way ui.js's tablist does.
          (d.querySelector(`[aria-controls="${view}"]`) as HTMLElement).click();
          expect((d.getElementById(view) as HTMLElement).hidden, `${view} did not open`).toBe(false);
        }
        const primaries = Array.from(d.querySelectorAll('main .btn-primary')).filter(reachable);
        expect(primaries.map((b) => squash(b.textContent)), `${view}: primary buttons`).toHaveLength(expected);
        for (const p of primaries) expect(p.getAttribute('href'), `${view}: a primary with no destination`).toBeTruthy();
      }
    } finally {
      page.close();
    }
  });
});

// ------------------------------------------------------------- laid out right

// Every control a person can reach, at the width under test. A link inside
// a sentence is exempt (WCAG 2.5.8), the rule S1's sweep uses. The nav and
// footer are measured by their own suites.
const SWEEP = `
  (function () {
    function inSentence(a) {
      return [].some.call(a.parentElement.childNodes, function (n) {
        return n.nodeType === 3 && n.textContent.trim().length > 0;
      });
    }
    var doc = document.documentElement;
    var all = [].filter.call(document.querySelectorAll('main a[href], main button'), function (el) {
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

const captureDir = process.env.S2_CAPTURE_DIR ?? '';

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

describe('(f) laid out right at 1280 and 320, each tab selected and each disclosure open', () => {
  const PAGES: ReadonlyArray<readonly [string, string, string]> = [
    ['agent', agentPath(AGENT_DID), '#summary:not([data-pending])'],
    ['agent-cold', agentPath(COLD_DID), '#summary:not([data-pending])'],
    ['receipt', receiptPath(HIRE.id), '#claim:not([data-pending])'],
  ];
  for (const width of [1280, 320]) {
    it.each(PAGES)(`${width}px: %s`, async (label, path, readySelector) => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for the past-work layout sweep; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width, height: 900 });
      try {
        if (width === 320) {
          await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 2, mobile: true });
          await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        }
        await browser.goto(`${baseUrl}${path}`, 400);
        const deadline = Date.now() + 10_000;
        while (!(await browser.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(readySelector)})`))) {
          if (Date.now() > deadline) throw new Error(`${label} never rendered its record`);
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 700));

        const states: string[] = label.startsWith('agent') ? [...TABS, 'details'] : ['loaded', 'details'];
        for (const state of states) {
          if (TABS.includes(state)) {
            await browser.evaluate(`document.querySelector('[aria-controls="${state}"]').click()`);
          } else if (state === 'details') {
            await browser.evaluate(`[].forEach.call(document.querySelectorAll('main .disclose'), function (b) { if (b.getAttribute('aria-expanded') !== 'true') b.click(); })`);
          }
          await new Promise((r) => setTimeout(r, 300));
          if (TABS.includes(state)) {
            expect(await browser.evaluate<boolean>(`!document.getElementById('${state}').hidden`), `${state} did not open`).toBe(true);
          }
          if (state === 'details') {
            const open = await browser.evaluate<number>(`[].filter.call(document.querySelectorAll('main .detail'), function (d) { return d.getBoundingClientRect().height > 0; }).length`);
            expect(open, `${label}: no disclosure opened`).toBe(label.startsWith('agent') ? 1 : 3);
          }
          const s = await browser.evaluate<Sweep>(SWEEP);
          expect(s.measured, `${label} ${state}: nothing to measure, the page did not render its <main>`).toBeGreaterThan(3);
          expect(s.past, `${label} at ${width}, ${state}: past the right edge`).toEqual([]);
          expect(s.scrollWidth, `${label} at ${width}, ${state}: sideways scroll`).toBe(s.clientWidth);
          // The 44px floor is a touch rule, checked at 320 with touch
          // emulated (S1's rule); at 1280 the shared button system is 40px,
          // a pointer size owned by the site's CSS and not by this card.
          if (width === 320) expect(s.small, `${label} at ${width}, ${state}: under 44px`).toEqual([]);
          if (TABS.includes(state) || state === 'details' || state === 'loaded') await capture(browser, `${label}-${width}-${state}`);
        }
      } finally {
        await browser.close();
      }
    }, BROWSER_TIMEOUT_MS);
  }
});
