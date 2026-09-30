// FIX-SW12i (SW3-13): /agreement promises "Either side can walk away, and
// nothing unwinds" and, until this card, no page gave either side a control
// that did it. POST /jobs/:jobId/withdraw (the buyer) and POST
// /jobs/:jobId/decline (the agent's side) both existed and nothing called
// them. These pins drive the real app over HTTP with real sessions for the
// buyer, the agent's owner and a stranger, click the controls in the page,
// and read the outcome back from GET /jobs/:id, never from the page.
//
// THE WINDOW. A control shows while the job is a draft, or proposed with at
// least one mark still missing: the agreement page's own "before both
// signatures". Once every line carries both marks the deposit is payable
// while the job is still proposed (legStatusEligible), and the projection
// does not say whether it settled, so a sheet row saying nothing has been
// paid could not be known true there. The fully signed proposed job below
// is pinned to show neither control for that reason.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemorySettlementGate } from '../../src/adapters/payment/gate.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:wa-agent';
const OWNER_DID = 'did:abt:wa-owner';
const BUYER_DID = 'did:abt:wa-buyer';
const STRANGER_DID = 'did:abt:wa-stranger';

const WITHDRAW = 'Withdraw this hire';
const DECLINE = 'Decline this brief';
const WITHDRAW_ROWS = [
  'Nothing has been paid.',
  'The hire ends and cannot be reopened.',
  "The agent's owner sees it withdrawn the next time they open it.",
];
const DECLINE_ROWS = [
  'No money has moved.',
  'The hire ends and cannot be reopened.',
  'The buyer sees it declined the next time they open it.',
];
// The route's own 403 for an agent key the owner has not let negotiate
// (requireNegotiationAllowed, src/api/app.ts). A page session is the
// owner's, never the agent's key, so no page load can provoke it; the pin
// injects the route's exact body instead.
const AGENT_KEY_403 =
  "the owner has not allowed this agent to negotiate on its own signature; sign in as the operator, or have the operator turn on negotiatesOnOwnersBehalf for this agent";

function delegation(): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${AGENT_DID}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OWNER_DID,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: AGENT_DID },
    proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${AGENT_DID}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture' },
  };
}

const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const unsigned = [{ text: 'The cart survives a refresh', proposedBy: 'agent' as const, acceptedByBuyer: false, acceptedByAgent: false }];
const signed = [{ text: 'The cart survives a refresh', proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true }];

function job(id: string, overrides: Partial<Job> = {}): Job {
  const base = createJob({ id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/wa-repo', brief: 'Fix the checkout flow' }, RECENT);
  return { ...base, ...overrides };
}
const proposed = (id: string): Job => job(id, { status: 'proposed', criteria: unsigned, priceUsd: '300.00', deliveryWindowDays: 4 });

// Captures the URL a page script navigates to: jsdom cannot follow a
// cross-document navigation, and whatwg-url's parseURL is the one seam its
// href/assign paths call (tests/web/hire-flow.test.ts documents the seam).
const require = createRequire(import.meta.url);
const whatwgURL = require('whatwg-url') as { parseURL: (v: string, opts?: unknown) => unknown };

interface Post { path: string; auth: string | null }
interface Page { window: JSDOM['window']; document: Document; posts: Post[]; navigations: string[]; close: () => void }
type Fault = (path: string, init?: RequestInit) => Response | 'network' | null;

let server: Server;
let baseUrl: string;
let jobRepo: MemoryJobRepository;
let buyerToken: string;
let ownerToken: string;
let strangerToken: string;

async function render(path: string, token: string | null, fault?: Fault): Promise<Page> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (e: Error) => failures.push(e.message));
  const posts: Post[] = [];
  let inflight = 0;
  let lastSettle = Date.now();
  const markup = await (await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } })).text();
  const navigations: string[] = [];
  const original = whatwgURL.parseURL;
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (token !== null) window.sessionStorage.setItem('fa_session', JSON.stringify({ token }));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          if (init?.method === 'POST') {
            const headers = (init.headers ?? {}) as Record<string, string>;
            posts.push({ path: input, auth: headers.Authorization ?? null });
          }
          inflight += 1;
          const faulted = fault ? fault(input, init) : null;
          const done = (r: Response) => { inflight -= 1; lastSettle = Date.now(); return r; };
          if (faulted === 'network') return Promise.reject(new TypeError('Failed to fetch')).catch((e: unknown) => { inflight -= 1; lastSettle = Date.now(); throw e; });
          if (faulted !== null) return Promise.resolve(faulted).then(done);
          return fetch(new URL(input, baseUrl), init).then(done, (e: unknown) => { inflight -= 1; lastSettle = Date.now(); throw e; });
        },
      });
    },
  });
  whatwgURL.parseURL = function (this: unknown, v: string, opts?: unknown) {
    if (typeof v === 'string' && v.startsWith('/')) navigations.push(v);
    return original.call(this, v, opts);
  };
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  const page: Page = {
    window: dom.window,
    document: dom.window.document,
    posts,
    navigations,
    close: () => { whatwgURL.parseURL = original; dom.window.close(); },
  };
  (page as Page & { quiet: () => Promise<void> }).quiet = async () => {
    const deadline = Date.now() + 8000;
    while (inflight > 0 || Date.now() - lastSettle < 200) {
      if (Date.now() > deadline) throw new Error(`${path} kept reading past 8s`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await quiet(page);
  const real = failures.filter((m) => !m.includes('Not implemented: navigation'));
  if (real.length > 0) throw new Error(`page script failed on ${path}: ${real.join('; ')}`);
  return page;
}

async function quiet(page: Page): Promise<void> {
  await (page as Page & { quiet: () => Promise<void> }).quiet();
}

// The labels of every button and link a person can see: nothing inside a
// hidden ancestor, nothing inside a closed sheet.
function visibleLabels(page: Page): string[] {
  return Array.from(page.document.querySelectorAll('button, a'))
    .filter((el) => el.closest('[hidden]') === null && el.closest('dialog') === null)
    .map((el) => (el.textContent ?? '').trim());
}

function walkControls(page: Page): string[] {
  return visibleLabels(page).filter((t) => t === WITHDRAW || t === DECLINE);
}

async function status(id: string): Promise<string> {
  return ((await (await fetch(`${baseUrl}/jobs/${id}`, { headers: { Accept: 'application/json' } })).json()) as { status: string }).status;
}

async function apiPost(path: string, token: string): Promise<number> {
  return (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' })).status;
}

function control(page: Page, kind: 'withdraw' | 'decline'): HTMLButtonElement {
  const btn = page.document.getElementById(`${kind}-open`) as HTMLButtonElement | null;
  if (!btn) throw new Error(`no #${kind}-open on the page`);
  return btn;
}

async function press(page: Page, kind: 'withdraw' | 'decline', twice = false): Promise<void> {
  control(page, kind).click();
  const confirm = page.document.getElementById(`${kind}-confirm`) as HTMLButtonElement;
  confirm.click();
  if (twice) confirm.click();
  await quiet(page);
}

const PAGES = {
  jobsBuyer: (id: string) => [`/jobs/${id}`, 'buyer'] as const,
  agreementBuyer: (id: string) => [`/agreement?job=${id}`, 'buyer'] as const,
  agreementOwner: (id: string) => [`/agreement?job=${id}`, 'owner'] as const,
  operatorOwner: (id: string) => [`/operatorjob?job=${id}`, 'owner'] as const,
};
const tokenFor = (who: 'buyer' | 'owner'): string => (who === 'buyer' ? buyerToken : ownerToken);

beforeAll(async () => {
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({ did: AGENT_DID, operatorDid: OWNER_DID, delegation: delegation(), name: 'wa-scout', skills: ['triage'], githubLogin: null, floorPriceUsd: null });
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: OWNER_DID, githubLogin: 'wa-owner' });
  await accountRepo.register({ did: BUYER_DID, githubLogin: 'wa-buyer' });
  await accountRepo.register({ did: STRANGER_DID, githubLogin: 'wa-stranger' });
  jobRepo = new MemoryJobRepository();
  const gate = new MemorySettlementGate();
  gate.markDepositSettled('wa-d-deposit');

  let login = 'wa-owner';
  const adapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: ((input: string, init?: RequestInit) => fakeGitHubFetch({ login, id: login.length })(input, init)) as typeof fetch,
  });
  server = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined,
    { verify: 10_000, read: 10_000, write: 10_000, upstream: 10_000 }, undefined, undefined, adapter, undefined, gate).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ownerToken = await mintSessionToken(adapter);
  login = 'wa-buyer';
  buyerToken = await mintSessionToken(adapter);
  login = 'wa-stranger';
  strangerToken = await mintSessionToken(adapter);

  await jobRepo.create(job('wa-draft'));
  await jobRepo.create(proposed('wa-proposed'));
  await jobRepo.create(job('wa-agreed', { status: 'proposed', criteria: signed, priceUsd: '300.00', deliveryWindowDays: 4, priceAcceptedByBuyer: true, priceAcceptedByAgent: true }));
  // Every line signed, the price missing the buyer's mark: still open.
  await jobRepo.create(job('wa-price-open', { status: 'proposed', criteria: signed, priceUsd: '300.00', deliveryWindowDays: 4, priceAcceptedByBuyer: false, priceAcceptedByAgent: true }));
  await jobRepo.create(job('wa-last-mark', { status: 'proposed', criteria: signed, priceUsd: '300.00', deliveryWindowDays: 4, priceAcceptedByBuyer: false, priceAcceptedByAgent: true }));
  // Lines sent, no price yet (the buyer sent lines first): still open.
  await jobRepo.create(job('wa-no-price', { status: 'proposed', criteria: signed }));
  const agreedTerms = { criteria: signed, priceUsd: '300.00', deliveryWindowDays: 4, priceAcceptedByBuyer: true, priceAcceptedByAgent: true, confirmedAt: RECENT, confirmedSpecHash: 'sha256:wa' };
  await jobRepo.create(job('wa-confirmed', { status: 'confirmed', ...agreedTerms }));
  await jobRepo.create(job('wa-staged', { status: 'staged', ...agreedTerms, stagedCommit: 'a'.repeat(40), stagedAt: RECENT }));
  await jobRepo.create(job('wa-completed', { status: 'completed', ...agreedTerms }));
  await jobRepo.create(job('wa-declined', { status: 'declined' }));
  await jobRepo.create(job('wa-withdrawn', { status: 'withdrawn' }));
  for (const id of ['wa-w-jobs', 'wa-w-agr', 'wa-d-op', 'wa-d-agr', 'wa-w-409', 'wa-d-409', 'wa-w-403', 'wa-d-403', 'wa-d-deposit', 'wa-w-double', 'wa-d-double', 'wa-rows', 'wa-shot-jobs', 'wa-shot-op']) {
    await jobRepo.create(proposed(id));
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('(a) inside the window, the hirer can withdraw and the owner can decline', () => {
  it.each([
    ['the hirer on /jobs', WITHDRAW, 'jobsBuyer'],
    ['the hirer on /agreement', WITHDRAW, 'agreementBuyer'],
    ['the owner on /agreement', DECLINE, 'agreementOwner'],
    ['the owner on /operatorjob', DECLINE, 'operatorOwner'],
  ] as const)('%s sees exactly one "%s" control, on a draft and on a proposed job with a mark missing', async (_who, label, key) => {
    for (const id of ['wa-draft', 'wa-proposed', 'wa-price-open', 'wa-no-price']) {
      const [path, who] = PAGES[key](id);
      const page = await render(path, tokenFor(who));
      try {
        expect(walkControls(page), `${path} as the ${who}`).toEqual([label]);
      } finally {
        page.close();
      }
    }
  });
});

describe('(b) nowhere else, and for nobody else', () => {
  it.each(['wa-agreed', 'wa-confirmed', 'wa-staged', 'wa-completed', 'wa-declined', 'wa-withdrawn'])(
    '%s: neither control on /jobs, /agreement (both seats) or /operatorjob',
    async (id) => {
      for (const at of Object.values(PAGES)) {
        const [path, who] = at(id);
        const page = await render(path, tokenFor(who));
        try {
          expect(walkControls(page), `${path} as the ${who}`).toEqual([]);
        } finally {
          page.close();
        }
      }
    },
  );

  // Each case also names what the page DID render for that visitor, so a
  // page that crashed before drawing anything cannot pass as "no control".
  it.each([
    ['a signed-out visitor on /jobs', '/jobs/wa-draft', null, 'state-label'],
    ['a signed-in stranger on /jobs', '/jobs/wa-draft', 'stranger', 'state-label'],
    ['the owner on /jobs', '/jobs/wa-draft', 'owner', 'state-label'],
    ['a signed-in stranger on /agreement', '/agreement?job=wa-draft', 'stranger', 'party-error'],
    ['a signed-in stranger on /operatorjob', '/operatorjob?job=wa-draft', 'stranger', 'party-error'],
    ['the hirer on /operatorjob', '/operatorjob?job=wa-draft', 'buyer', 'party-error'],
  ] as const)('%s sees neither control on a draft', async (_who, path, who, shown) => {
    const token = who === null ? null : who === 'stranger' ? strangerToken : tokenFor(who);
    const page = await render(path, token);
    try {
      const node = page.document.getElementById(shown);
      expect(node?.closest('[hidden]'), `#${shown} is not showing, so the page never rendered for this visitor`).toBeNull();
      if (shown === 'state-label') expect(node?.textContent).toContain('draft');
      expect(walkControls(page)).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('each seat sees only its own control: the hirer never Decline, the owner never Withdraw', async () => {
    for (const id of ['wa-draft', 'wa-proposed']) {
      for (const at of Object.values(PAGES)) {
        const [path, who] = at(id);
        const page = await render(path, tokenFor(who));
        try {
          const labels = visibleLabels(page);
          expect(labels.length, `${path}: no labels at all, so this check would be vacuous`).toBeGreaterThan(3);
          expect(labels, `${path} as the ${who}`).not.toContain(who === 'buyer' ? DECLINE : WITHDRAW);
        } finally {
          page.close();
        }
      }
    }
  });

  it('the hirer on /jobs sees no control while the account read fails', async () => {
    const page = await render('/jobs/wa-draft', buyerToken, (p) =>
      p === '/accounts/me' ? new Response(JSON.stringify({ error: 'storage unavailable' }), { status: 503 }) : null,
    );
    try {
      expect(page.document.getElementById('state-label')?.textContent).toContain('draft');
      expect(walkControls(page)).toEqual([]);
    } finally {
      page.close();
    }
  });
});

describe('(c) the confirm posts once, with the session, and lands on the end state', () => {
  it('/jobs: the hirer withdraws, and the page reads the hire again into its withdrawn sentence', async () => {
    const page = await render('/jobs/wa-w-jobs', buyerToken);
    try {
      await press(page, 'withdraw');
      expect(page.posts).toEqual([{ path: '/jobs/wa-w-jobs/withdraw', auth: `Bearer ${buyerToken}` }]);
      expect(await status('wa-w-jobs')).toBe('withdrawn');
      expect(page.document.getElementById('state-label')?.textContent).toBe('The buyer withdrew this hire.');
      expect(walkControls(page)).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('/operatorjob: the owner declines, and the page reads the hire again into its declined sentence', async () => {
    const page = await render('/operatorjob?job=wa-d-op', ownerToken);
    try {
      await press(page, 'decline');
      expect(page.posts).toEqual([{ path: '/jobs/wa-d-op/decline', auth: `Bearer ${ownerToken}` }]);
      expect(await status('wa-d-op')).toBe('declined');
      expect(page.document.getElementById('state-heading')?.textContent).toBe('This hire was declined');
      expect(page.document.getElementById('state-lede')?.textContent).toBe('This hire was declined before work was staged.');
      expect(walkControls(page)).toEqual([]);
    } finally {
      page.close();
    }
  });

  it.each([
    ['the hirer withdraws', 'wa-w-agr', 'buyer', 'withdraw', '/jobs/wa-w-agr', 'withdrawn', 'state-label', 'The buyer withdrew this hire.'],
    ['the owner declines', 'wa-d-agr', 'owner', 'decline', '/operatorjob?job=wa-d-agr', 'declined', 'state-lede', 'This hire was declined before work was staged.'],
  ] as const)('/agreement: %s, and the page goes where that end state is written', async (_what, id, who, kind, dest, end, nodeId, sentence) => {
    const token = tokenFor(who);
    const page = await render(`/agreement?job=${id}`, token);
    try {
      // Only what is asked for after the press counts: the page's own
      // back link already parsed these same addresses at load.
      const before = page.navigations.length;
      await press(page, kind);
      expect(page.posts).toEqual([{ path: `/jobs/${id}/${kind}`, auth: `Bearer ${token}` }]);
      expect(await status(id)).toBe(end);
      expect(page.navigations.slice(before)).toContain(dest);
    } finally {
      page.close();
    }
    const landed = await render(dest, token);
    try {
      expect(landed.document.getElementById(nodeId)?.textContent).toBe(sentence);
    } finally {
      landed.close();
    }
  });

  it('a double press posts once, on both sheets', async () => {
    for (const [path, who, kind] of [['/jobs/wa-w-double', 'buyer', 'withdraw'], ['/operatorjob?job=wa-d-double', 'owner', 'decline']] as const) {
      const page = await render(path, tokenFor(who));
      try {
        await press(page, kind, true);
        expect(page.posts.length, `${path}: ${JSON.stringify(page.posts)}`).toBe(1);
      } finally {
        page.close();
      }
    }
  });

  // Each refusal is the server's own sentence, whole, in the sheet's alert
  // node, which carries role="alert" before anything is written to it.
  it.each([
    ['/jobs, 409: the owner declined while the hirer read the page', '/jobs/wa-w-409', 'buyer', 'withdraw', null, 'this job is "declined", a final status, so it cannot change'],
    ['/operatorjob, 409: the hirer withdrew while the owner read the page', '/operatorjob?job=wa-d-409', 'owner', 'decline', null, 'this job is "withdrawn", a final status, so it cannot change'],
    ['/operatorjob, 409: the deposit settled', '/operatorjob?job=wa-d-deposit', 'owner', 'decline', null, 'job wa-d-deposit has a settled deposit; it can no longer be declined'],
    ['/agreement, 403 on the withdraw route', '/agreement?job=wa-w-403', 'buyer', 'withdraw', 'only the buyer may withdraw this job', 'only the buyer may withdraw this job'],
    ['/agreement, 403 for an agent key', '/agreement?job=wa-d-403', 'owner', 'decline', AGENT_KEY_403, AGENT_KEY_403],
  ] as const)('%s', async (_what, path, who, kind, injected403, sentence) => {
    const fault: Fault | undefined = injected403 === null ? undefined : (p, init) =>
      init?.method === 'POST' && p.endsWith(`/${kind}`) ? new Response(JSON.stringify({ error: injected403 }), { status: 403 }) : null;
    const page = await render(path, tokenFor(who), fault);
    try {
      const alertNode = page.document.getElementById(`${kind}-alert`);
      expect(alertNode?.getAttribute('role')).toBe('alert');
      expect(alertNode?.textContent).toBe('');
      if (path.includes('409')) {
        const id = path.split(/[/=]/).pop()!;
        expect(await apiPost(`/jobs/${id}/${kind === 'withdraw' ? 'decline' : 'withdraw'}`, kind === 'withdraw' ? ownerToken : buyerToken)).toBe(200);
      }
      await press(page, kind);
      expect(page.posts.length).toBe(1);
      expect(alertNode?.textContent).toBe(sentence);
      expect(alertNode?.hasAttribute('hidden')).toBe(false);
      expect((page.document.getElementById(`${kind}-confirm`) as HTMLButtonElement).disabled, 'the confirm stays locked after a refusal').toBe(false);
    } finally {
      page.close();
    }
  });

  it('a press that never reaches the server says so in the alert node, and changes nothing', async () => {
    const page = await render('/jobs/wa-rows', buyerToken, (p, init) => (init?.method === 'POST' ? 'network' : null));
    try {
      await press(page, 'withdraw');
      expect(page.document.getElementById('withdraw-alert')?.textContent).toBe('Could not reach the server just now. Try again in a moment.');
      expect(await status('wa-rows')).toBe('proposed');
    } finally {
      page.close();
    }
  });

  // The three answers written for a caller rather than a person get a
  // sentence of the page's own: the 401 names R-34, the 503 says
  // "storage", and a body with no error has nothing to show.
  it.each([
    [401, { error: 'this route requires a session (sign in with GitHub OAuth or a passkey) or a verified request signature (R-34)' }, 'Your session has expired. Sign in again to withdraw this hire.'],
    [503, { error: 'storage unavailable' }, 'Storage is unavailable just now. Try again in a moment.'],
    [500, {}, 'That could not be done just now. Try again in a moment.'],
  ] as const)('a %i shows the page\u2019s own sentence', async (code, body, sentence) => {
    const page = await render('/jobs/wa-rows', buyerToken, (p, init) =>
      init?.method === 'POST' ? new Response(JSON.stringify(body), { status: code }) : null,
    );
    try {
      await press(page, 'withdraw');
      expect(page.document.getElementById('withdraw-alert')?.textContent).toBe(sentence);
    } finally {
      page.close();
    }
  });

  it('Cancel and the close control shut the sheet and post nothing', async () => {
    const page = await render('/operatorjob?job=wa-rows', ownerToken);
    try {
      const sheet = page.document.getElementById('decline-sheet') as HTMLDialogElement;
      for (const closer of ['Cancel', 'Close']) {
        control(page, 'decline').click();
        expect(sheet.hasAttribute('open')).toBe(true);
        const btn = Array.from(sheet.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') ?? b.textContent) === closer);
        (btn as HTMLButtonElement).click();
        expect(sheet.hasAttribute('open'), `${closer} left the sheet open`).toBe(false);
      }
      expect(page.posts).toEqual([]);
    } finally {
      page.close();
    }
  });

  it('/agreement: signing the last mark closes the window, and the control goes with it', async () => {
    const page = await render('/agreement?job=wa-last-mark', buyerToken);
    try {
      expect(walkControls(page)).toEqual([WITHDRAW]);
      const sign = page.document.querySelector('#terms button.sig.is-waiting') as HTMLButtonElement;
      sign.click();
      await quiet(page);
      expect(page.posts.map((p) => p.path)).toEqual(['/jobs/wa-last-mark/price/accept']);
      expect(walkControls(page)).toEqual([]);
    } finally {
      page.close();
    }
  });
});

describe('(d) each sheet says what happens, in whole sentences', () => {
  it.each([
    ['/jobs', '/jobs/wa-rows', 'buyer', 'withdraw', WITHDRAW, 'Withdraw, and end this hire', WITHDRAW_ROWS],
    ['/agreement, hirer', '/agreement?job=wa-rows', 'buyer', 'withdraw', WITHDRAW, 'Withdraw, and end this hire', WITHDRAW_ROWS],
    ['/agreement, owner', '/agreement?job=wa-rows', 'owner', 'decline', DECLINE, 'Decline, and end this hire', DECLINE_ROWS],
    ['/operatorjob', '/operatorjob?job=wa-rows', 'owner', 'decline', DECLINE, 'Decline, and end this hire', DECLINE_ROWS],
  ] as const)('%s', async (_where, path, who, kind, heading, confirmLabel, rows) => {
    const page = await render(path, tokenFor(who));
    try {
      control(page, kind).click();
      const sheet = page.document.getElementById(`${kind}-sheet`) as HTMLDialogElement;
      expect(sheet.tagName).toBe('DIALOG');
      expect(sheet.classList.contains('sheet')).toBe(true);
      // jsdom has no showModal; the pages fall back to the open attribute.
      expect(sheet.hasAttribute('open')).toBe(true);
      expect(sheet.querySelector('.shead h2')?.textContent).toBe(heading);
      expect(Array.from(sheet.querySelectorAll('.sbody ul.factlist > li')).map((li) => li.textContent)).toEqual(rows);
      expect(page.document.getElementById(`${kind}-confirm`)?.textContent).toBe(confirmLabel);
      expect(page.posts, 'opening the sheet posted something').toEqual([]);
    } finally {
      page.close();
    }
  });
});

// The sheet's rules live in polish.css, which /jobs and /agreement load and
// flow.css does not reach.
describe('the sheet has one home', () => {
  it('polish.css declares the sheet, keyed on dialog.sheet, and flow.css no longer does', async () => {
    const read = async (name: string) => (await (await fetch(`${baseUrl}/css/${name}`)).text()).replace(/\/\*[\s\S]*?\*\//g, '');
    const polish = await read('polish.css');
    const flow = await read('flow.css');
    expect(polish).toMatch(/(^|\n)dialog\.sheet\s*\{[^}]*width:\s*min\(520px,\s*calc\(100vw - 24px\)\)/);
    expect(polish).toMatch(/(^|\n)dialog\.sheet::backdrop\s*\{/);
    for (const sel of ['.sheet .shead {', '.sheet .sbody {', '.sheet .sfoot {', '.sheet .sfoot .btn {', '.sclose {']) {
      expect(polish, `polish.css must declare ${sel}`).toContain(sel);
      expect(flow, `flow.css still declares ${sel}: a second copy`).not.toContain(sel);
    }
    // A bare `.sheet {` here would reach /messages's own div.sheet.
    expect(polish).not.toMatch(/(^|[\s}])\.sheet\s*\{/);
    expect(flow).not.toMatch(/\.sheet\s*(::backdrop)?\s*\{/);
  });
});

// Measured in a real browser at the three widths
// the house checks, with the sheet OPEN: the dialog wears the sheet chrome
// (the inset shadow and the 44px close box come only from that block), fits
// the viewport, and every control in it clears the 44px floor on a phone.
describe('the sheets, open, at 320, 390 and 1280', () => {
  it('fit, wear the sheet chrome, and keep every control at 44px or more on a phone', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const browser = await RealBrowser.launch({ width: 1280, height: 900 });
    try {
      const cases = [
        ['/jobs/wa-shot-jobs', buyerToken, 'withdraw'],
        ['/agreement?job=wa-shot-jobs', buyerToken, 'withdraw'],
        ['/agreement?job=wa-shot-op', ownerToken, 'decline'],
        ['/operatorjob?job=wa-shot-op', ownerToken, 'decline'],
      ] as const;
      for (const width of [320, 390, 1280]) {
        const phone = width < 760;
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: phone });
        await browser.send('Emulation.setTouchEmulationEnabled', { enabled: phone });
        for (const [path, token, kind] of cases) {
          await browser.goto(`${baseUrl}/`, 100);
          await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token }))}); true`);
          await browser.goto(`${baseUrl}${path}`, 900);
          await browser.evaluate(`document.getElementById('${kind}-open').click(); true`);
          await new Promise((r) => setTimeout(r, 250));
          const m = await browser.evaluate<{ open: boolean; right: number; doc: [number, number]; shadow: string; close: [number, number]; small: string[]; openBtn: number }>(`
            (function () {
              var d = document.getElementById('${kind}-sheet');
              var r = d.getBoundingClientRect();
              var c = d.querySelector('.sclose').getBoundingClientRect();
              var small = Array.from(d.querySelectorAll('button')).filter(function (b) {
                var br = b.getBoundingClientRect(); return br.width < 44 || br.height < 44;
              }).map(function (b) { var br = b.getBoundingClientRect(); return (b.id || b.textContent.trim()) + ' ' + Math.round(br.width) + 'x' + Math.round(br.height); });
              return {
                open: d.open, right: Math.round(r.right),
                doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
                shadow: getComputedStyle(d).boxShadow,
                close: [Math.round(c.width), Math.round(c.height)], small: small,
                openBtn: Math.round(document.getElementById('${kind}-open').getBoundingClientRect().height)
              };
            })()
          `);
          const where = `${path} at ${width}`;
          expect(m.open, `${where}: the sheet did not open`).toBe(true);
          expect(m.doc[0], `${where}: the page scrolls sideways with the sheet open`).toBe(m.doc[1]);
          expect(m.right, `${where}: the sheet runs off the right edge`).toBeLessThanOrEqual(m.doc[1]);
          expect(m.shadow, `${where}: the sheet chrome is not in force`).toContain('inset');
          expect(m.close, `${where}: the close control is not the 44px box`).toEqual([44, 44]);
          if (phone) {
            expect(m.small, `${where}: sheet controls under 44px`).toEqual([]);
            expect(m.openBtn, `${where}: the control that opens the sheet is under 44px`).toBeGreaterThanOrEqual(44);
          }
          // Set WALK_AWAY_CAPTURE_DIR to also save each open sheet at 390.
          const dir = process.env['WALK_AWAY_CAPTURE_DIR'];
          if (dir && width === 390) {
            const shot = (await browser.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
            const name = `${path.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}-${kind}-390.png`;
            writeFileSync(join(dir, name), Buffer.from(shot.result?.data ?? '', 'base64'));
          }
        }
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});
