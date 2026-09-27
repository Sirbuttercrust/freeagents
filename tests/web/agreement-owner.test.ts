// FIX-B40: the agent's owner writes, changes and signs the quote on
// /agreement. Driven end to end against the real app over HTTP, with real
// sessions for the owner (the account whose DID is the agent's
// operatorDid) and the buyer, minted through the sign-in path. Every
// control is clicked in the page and every result is read back from GET
// /jobs/:id, never from the page's own claim.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENT_DID = 'did:abt:b40-agent';
const OWNER_DID = 'did:abt:b40-owner-account';
const BUYER_DID = 'did:abt:b40-buyer-account';
const BUYER_LOGIN = 'b40-buyer';

function delegationFixture(): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${AGENT_DID}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OWNER_DID,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: AGENT_DID },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${AGENT_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string }): Job {
  const base = createJob(
    { id: overrides.id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/b40-repo', brief: 'Fix the checkout flow' },
    new Date(),
  );
  return { ...base, ...overrides };
}

const unsigned = (text: string, proposedBy: 'agent' | 'buyer' = 'agent') => ({ text, proposedBy, acceptedByBuyer: false, acceptedByAgent: false });

interface Rendered {
  window: JSDOM['window'];
  document: Document;
  posts: Array<{ path: string; body: Record<string, unknown> }>;
  close: () => void;
}

const wait = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

async function render(
  baseUrl: string,
  jobId: string,
  token: string,
  opts: { fault?: (path: string) => Response | null; storage?: Record<string, string> } = {},
): Promise<Rendered> {
  const path = `/agreement?job=${encodeURIComponent(jobId)}`;
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  const posts: Rendered['posts'] = [];
  const markup = await (await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } })).text();
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.sessionStorage.setItem('fa_session', JSON.stringify({ token }));
      for (const [k, v] of Object.entries(opts.storage ?? {})) window.sessionStorage.setItem(k, v);
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: (input: string, init?: RequestInit) => {
          if (init?.method === 'POST') posts.push({ path: input, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
          const faulted = opts.fault ? opts.fault(input) : null;
          if (faulted !== null) return Promise.resolve(faulted);
          return fetch(new URL(input, baseUrl), init);
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await wait(350);
  if (failures.length > 0) throw new Error(`page script failed on ${path}: ${failures.join('; ')}`);
  return { window: dom.window, document: dom.window.document, posts, close: () => dom.window.close() };
}

function rows(page: Rendered): Element[] {
  return Array.from(page.document.querySelectorAll('#terms > li'));
}

async function click(el: Element | null | undefined, ms = 250): Promise<void> {
  if (!el) throw new Error('no element to click');
  (el as HTMLElement).click();
  await wait(ms);
}

function type(page: Rendered, input: Element | null | undefined, value: string): void {
  if (!input) throw new Error('no input to type into');
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
}

// Opens row N's editor, types, and presses Save.
async function editRow(page: Rendered, rowIndex: number, value: string): Promise<void> {
  await click(rows(page)[rowIndex]?.querySelector('button.act'), 50);
  const editor = rows(page)[rowIndex]?.querySelector('.line-edit');
  type(page, editor?.querySelector('input'), value);
  await click(Array.from(editor?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Save'));
}

describe('the owner\u2019s side of /agreement, driven end to end (FIX-B40)', () => {
  let jobRepo: MemoryJobRepository;
  let server: Server;
  let baseUrl: string;
  let ownerToken: string;
  let buyerToken: string;

  interface ReadJob {
    status: string;
    criteria: Array<{ text: string; proposedBy: string; acceptedByBuyer: boolean; acceptedByAgent: boolean }>;
    price: { priceUsd: string; rail: string | null; deliveryWindowDays: number; acceptedByBuyer: boolean; acceptedByAgent: boolean };
  }

  async function readJob(id: string): Promise<ReadJob> {
    return (await (await fetch(`${baseUrl}/jobs/${id}`, { headers: { Accept: 'application/json' } })).json()) as ReadJob;
  }

  async function post(path: string, token: string, body: unknown = {}): Promise<number> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return res.status;
  }

  beforeAll(async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: OWNER_DID,
      delegation: delegationFixture(),
      name: 'b40-scout',
      skills: ['triage'],
      githubLogin: null,
      floorPriceUsd: '100.00',
    });
    const accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: OWNER_DID, githubLogin: 'b40-owner' });
    await accountRepo.register({ did: BUYER_DID, githubLogin: BUYER_LOGIN });
    jobRepo = new MemoryJobRepository();

    // One adapter, two people: the fake GitHub answers whichever login
    // is current when a session is minted.
    let login = 'b40-owner';
    const adapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: ((input: string, init?: RequestInit) => fakeGitHubFetch({ login, id: login.length })(input, init)) as typeof fetch,
    });
    server = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined, adapter).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ownerToken = await mintSessionToken(adapter);
    login = BUYER_LOGIN;
    buyerToken = await mintSessionToken(adapter);

    await jobRepo.create(jobFixture({ id: 'b40-draft', status: 'draft' }));
    await jobRepo.create(jobFixture({ id: 'b40-seat', status: 'proposed', criteria: [unsigned('Agent line'), unsigned('Buyer line', 'buyer')], priceUsd: '300.00', deliveryWindowDays: 4 }));
    await jobRepo.create(jobFixture({ id: 'b40-sign', status: 'proposed', criteria: [unsigned('Sign me')], priceUsd: '300.00', deliveryWindowDays: 4 }));
    await jobRepo.create(jobFixture({ id: 'b40-edit', status: 'proposed', criteria: [unsigned('One'), unsigned('Two'), unsigned('Three')], priceUsd: '300.00', deliveryWindowDays: 4 }));
    await jobRepo.create(jobFixture({ id: 'b40-price', status: 'proposed', criteria: [unsigned('Only')], priceUsd: '500.00', deliveryWindowDays: 7 }));
    await jobRepo.create(jobFixture({ id: 'b40-window', status: 'proposed', criteria: [unsigned('Only')], priceUsd: '500.00', deliveryWindowDays: 7 }));
    await jobRepo.create(jobFixture({ id: 'b40-floor', status: 'proposed', criteria: [unsigned('Only')], priceUsd: '500.00', deliveryWindowDays: 7 }));
    await jobRepo.create(jobFixture({ id: 'b40-add', status: 'proposed', criteria: [unsigned('Existing')], priceUsd: '300.00', deliveryWindowDays: 4 }));
    await jobRepo.create(jobFixture({ id: 'b40-withdrawn', status: 'proposed', criteria: [unsigned('Going away')], priceUsd: '300.00', deliveryWindowDays: 4 }));
    await jobRepo.create(jobFixture({
      id: 'b40-agreed', status: 'proposed',
      criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      priceUsd: '300.00', deliveryWindowDays: 4, priceAcceptedByBuyer: true, priceAcceptedByAgent: true,
    }));
    await jobRepo.create(jobFixture({
      id: 'b40-confirmed', status: 'confirmed',
      criteria: [{ text: 'Done', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
      priceUsd: '300.00', deliveryWindowDays: 4, priceAcceptedByBuyer: true, priceAcceptedByAgent: true,
      confirmedAt: new Date(), confirmedSpecHash: 'sha256:b40',
    }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('(a) the seat', () => {
    it('the owner\u2019s session reads the agent\u2019s marks as "You", heads the other column with the buyer\u2019s login, and gets an edit control on every row', async () => {
      const page = await render(baseUrl, 'b40-seat', ownerToken);
      try {
        expect(page.document.getElementById('agreement-body')!.hidden).toBe(false);
        expect(page.document.getElementById('h-them')?.textContent).toBe(`@${BUYER_LOGIN}`);
        expect(rows(page).length).toBe(4);
        rows(page).forEach((row) => expect(row.querySelector('button.act')).not.toBeNull());
        expect(rows(page)[1]!.querySelector('.from')?.textContent).toBe(`@${BUYER_LOGIN} proposed this`);
        expect(page.document.getElementById('lockbar')?.textContent).toContain('waiting on you');
        expect(page.document.getElementById('compose-send')).toBeNull();
      } finally {
        page.close();
      }
    });

    it('the buyer\u2019s session on the same job renders the buyer\u2019s side, with no edit control', async () => {
      const page = await render(baseUrl, 'b40-seat', buyerToken);
      try {
        expect(page.document.getElementById('h-them')?.textContent).toBe('Agent');
        expect(page.document.querySelectorAll('#terms button.act').length).toBe(0);
        expect(rows(page)[0]!.querySelector('.act')?.textContent).toBe('not yet');
        expect(rows(page)[1]!.querySelector('.from')?.textContent).toBe('you proposed this');
      } finally {
        page.close();
      }
    });

    it('/accounts/me answering 503 renders the load error and no control at all', async () => {
      const fault = (p: string) => (p === '/accounts/me' ? new Response(JSON.stringify({ error: 'storage unavailable' }), { status: 503 }) : null);
      const page = await render(baseUrl, 'b40-seat', ownerToken, { fault });
      try {
        expect(page.document.getElementById('load-error')!.hidden).toBe(false);
        expect(page.document.getElementById('agreement-body')!.hidden).toBe(true);
        expect(page.document.querySelectorAll('#terms > li').length).toBe(0);
        expect(page.document.querySelectorAll('button.act, button.sig, #compose-send').length).toBe(0);
      } finally {
        page.close();
      }
    });
  });

  describe('(b) a draft job from the owner\u2019s side', () => {
    it('the first line goes out through the propose field, then the unset price row sets the price with no rail', async () => {
      const page = await render(baseUrl, 'b40-draft', ownerToken);
      try {
        expect(page.document.getElementById('propose-field')!.hidden).toBe(false);
        expect(page.document.getElementById('lockbar')?.textContent).toContain('No lines yet.');
        type(page, page.document.getElementById('newcrit'), 'The cart survives a refresh');
        await click(page.document.getElementById('propose-submit'));
        expect(page.posts.at(-1)!.body).toEqual({ criteria: [{ text: 'The cart survives a refresh', proposedBy: 'agent' }] });
        let job = await readJob('b40-draft');
        expect(job.status).toBe('proposed');

        // The page re-rendered from the response: one line and a price row to set.
        expect(rows(page).length).toBe(2);
        expect(rows(page)[1]!.querySelector('.txt')?.textContent).toBe('Price: not set yet');
        expect(rows(page)[1]!.querySelectorAll('button.sig').length).toBe(0);
        expect(page.document.getElementById('lockbar')?.textContent).toContain('Waiting on you to set the price.');

        await editRow(page, 1, '400');
        expect(page.posts.at(-1)!.body).toEqual({
          criteria: [{ text: 'The cart survives a refresh', proposedBy: 'agent' }],
          priceUsd: '400.00',
        });
        job = await readJob('b40-draft');
        expect(job.price).toMatchObject({ priceUsd: '400.00', rail: null });
        expect(rows(page).length).toBe(3);
        expect(rows(page)[1]!.querySelector('.txt')?.textContent).toBe('Price: $400.00');
      } finally {
        page.close();
      }
    });
  });

  describe('(c) signing as the owner', () => {
    it('flips acceptedByAgent and never acceptedByBuyer, for a line and for the price pair', async () => {
      const page = await render(baseUrl, 'b40-sign', ownerToken);
      try {
        await click(rows(page)[0]!.querySelectorAll('.sigcell')[0]!.querySelector('button.sig'));
        let job = await readJob('b40-sign');
        expect(job.criteria[0]).toMatchObject({ acceptedByAgent: true, acceptedByBuyer: false });
        expect(job.price).toMatchObject({ acceptedByAgent: false, acceptedByBuyer: false });

        await click(rows(page)[1]!.querySelectorAll('.sigcell')[0]!.querySelector('button.sig'));
        job = await readJob('b40-sign');
        expect(job.price).toMatchObject({ acceptedByAgent: true, acceptedByBuyer: false });
        expect(page.document.getElementById('lockbar')?.textContent).toContain(`Waiting on @${BUYER_LOGIN}`);
      } finally {
        page.close();
      }
    });
  });

  describe('(d) changing one line', () => {
    it('clears only that line\u2019s marks; every other line and the price keep theirs', async () => {
      for (const i of [0, 1, 2]) {
        expect(await post(`/jobs/b40-edit/criteria/${i}/accept`, buyerToken)).toBe(200);
        expect(await post(`/jobs/b40-edit/criteria/${i}/accept`, ownerToken)).toBe(200);
      }
      expect(await post('/jobs/b40-edit/price/accept', buyerToken)).toBe(200);
      const page = await render(baseUrl, 'b40-edit', ownerToken);
      try {
        await editRow(page, 1, 'Two, restated');
        expect(page.posts.at(-1)!.body).toEqual({
          criteria: [
            { text: 'One', proposedBy: 'agent' },
            { text: 'Two, restated', proposedBy: 'agent' },
            { text: 'Three', proposedBy: 'agent' },
          ],
        });
        const job = await readJob('b40-edit');
        expect(job.criteria[0]).toMatchObject({ text: 'One', acceptedByBuyer: true, acceptedByAgent: true });
        expect(job.criteria[1]).toMatchObject({ text: 'Two, restated', acceptedByBuyer: false, acceptedByAgent: false });
        expect(job.criteria[2]).toMatchObject({ text: 'Three', acceptedByBuyer: true, acceptedByAgent: true });
        expect(job.price).toMatchObject({ priceUsd: '300.00', acceptedByBuyer: true });
        expect(rows(page)[1]!.querySelector('.txt')?.textContent).toBe('Two, restated');
        expect(page.document.querySelector('.line-edit')).toBeNull();
      } finally {
        page.close();
      }
    });

    it('Cancel closes the editor and sends nothing', async () => {
      const page = await render(baseUrl, 'b40-seat', ownerToken);
      try {
        await click(rows(page)[0]!.querySelector('button.act'), 20);
        expect(page.document.querySelector('.line-edit')).not.toBeNull();
        await click(Array.from(page.document.querySelectorAll('.line-edit button')).find((b) => b.textContent === 'Cancel'), 20);
        expect(page.document.querySelector('.line-edit')).toBeNull();
        expect(page.posts.length).toBe(0);
      } finally {
        page.close();
      }
    });

    it('"Propose your own criterion" adds a line from the owner\u2019s side, keeping the list whole', async () => {
      const page = await render(baseUrl, 'b40-add', ownerToken);
      try {
        type(page, page.document.getElementById('newcrit'), 'A line the owner adds');
        await click(page.document.getElementById('propose-submit'));
        const job = await readJob('b40-add');
        expect(job.criteria.map((c: { text: string }) => c.text)).toEqual(['Existing', 'A line the owner adds']);
        expect(page.posts.at(-1)!.body).toEqual({
          criteria: [
            { text: 'Existing', proposedBy: 'agent' },
            { text: 'A line the owner adds', proposedBy: 'agent' },
          ],
        });
        expect(rows(page).length).toBe(4);
        expect(rows(page)[1]!.querySelector('button.act')?.getAttribute('aria-label')).toBe('Propose a change to line 02');
      } finally {
        page.close();
      }
    });
  });

  describe('(e) the price and the window travel together', () => {
    it('changing the price leaves the window as it was (a send without it would reset it to 14)', async () => {
      const page = await render(baseUrl, 'b40-price', ownerToken);
      try {
        await editRow(page, 1, '650');
        const job = await readJob('b40-price');
        expect(job.price).toMatchObject({ priceUsd: '650.00', deliveryWindowDays: 7 });
        expect('rail' in page.posts.at(-1)!.body).toBe(false);
      } finally {
        page.close();
      }
    });

    it('changing the window leaves the price as it was', async () => {
      const page = await render(baseUrl, 'b40-window', ownerToken);
      try {
        await editRow(page, 2, '9');
        const job = await readJob('b40-window');
        expect(job.price).toMatchObject({ priceUsd: '500.00', deliveryWindowDays: 9 });
        expect(rows(page)[2]!.querySelector('.txt')?.textContent).toBe('Ready in 9 days');
      } finally {
        page.close();
      }
    });
  });

  describe('(f) refusals change nothing but the sentence', () => {
    it('a price under the floor shows the server\u2019s sentence, keeps the field as typed, and the job is unchanged', async () => {
      const page = await render(baseUrl, 'b40-floor', ownerToken);
      try {
        await editRow(page, 1, '50');
        const error = page.document.querySelector('.line-edit .edit-error') as HTMLElement | null;
        expect(error?.hidden).toBe(false);
        expect(error?.textContent).toBe("proposed price 50.00 is below the agent's floor of 100.00");
        expect((page.document.querySelector('.line-edit input') as HTMLInputElement).value).toBe('50');
        expect((await readJob('b40-floor')).price.priceUsd).toBe('500.00');
      } finally {
        page.close();
      }
    });

    it('"40.5.0" is refused in one plain sentence before any request is made', async () => {
      const page = await render(baseUrl, 'b40-floor', ownerToken);
      try {
        await editRow(page, 1, '40.5.0');
        expect(page.posts.length).toBe(0);
        expect(page.document.querySelector('.line-edit .edit-error')?.textContent).toBe('Enter the price in dollars, like 400 or 400.50.');
      } finally {
        page.close();
      }
    });

    it('a job withdrawn after the page loaded answers 409 with a sentence naming the reload', async () => {
      const page = await render(baseUrl, 'b40-withdrawn', ownerToken);
      try {
        expect(await post('/jobs/b40-withdrawn/withdraw', buyerToken)).toBe(200);
        await editRow(page, 0, 'Restated');
        expect(page.document.querySelector('.line-edit .edit-error')?.textContent).toContain('Reload the page');
        expect(rows(page)[0]!.querySelector('.txt')?.textContent).toBe('Going away');
      } finally {
        page.close();
      }
    });
  });

  describe('(g) the lockbar, and a job past proposed', () => {
    it('fully agreed: says the buyer pays the deposit next, with no deposit link on the owner\u2019s side', async () => {
      const page = await render(baseUrl, 'b40-agreed', ownerToken);
      try {
        expect(page.document.getElementById('lockbar')?.textContent).toContain(`@${BUYER_LOGIN} pays the deposit next.`);
        expect(page.document.getElementById('deposit-row')!.hidden).toBe(true);
      } finally {
        page.close();
      }
    });

    it('a confirmed job: no edit, add, sign or send control for the owner', async () => {
      const page = await render(baseUrl, 'b40-confirmed', ownerToken);
      try {
        expect(rows(page).length).toBe(3);
        expect(page.document.querySelectorAll('#terms button').length).toBe(0);
        expect(page.document.getElementById('propose-field')!.hidden).toBe(true);
        expect(page.document.querySelector('.line-edit')).toBeNull();
      } finally {
        page.close();
      }
    });
  });

  // (i) Real Chrome: no sideways scroll at 320, 390 (touch) and 1280 with
  // a line edit, the price edit and the window edit open; every control is
  // 44px or more on touch; reduced motion leaves every row finished and
  // still.
  describe('(i) real layout of the owner\u2019s open states', () => {
    const VIEWPORTS = [
      { width: 320, touch: true },
      { width: 390, touch: true },
      { width: 1280, touch: false },
    ];
    it.each(VIEWPORTS)('at $width', async ({ width, touch }) => {
      if (!hasRealBrowser()) {
        console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
        return;
      }
      const browser = await RealBrowser.launch({ width, height: 900 });
      try {
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: touch });
        await browser.send('Emulation.setTouchEmulationEnabled', { enabled: touch });
        await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await browser.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `window.sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify({ token: ownerToken }))});`,
        });
        const states: Array<[string, string, string]> = [
          ['line edit', '/agreement?job=b40-seat', '#terms > li:nth-child(1) button.act'],
          ['price edit', '/agreement?job=b40-seat', '#terms > li:nth-child(3) button.act'],
          ['window edit', '/agreement?job=b40-seat', '#terms > li:nth-child(4) button.act'],
        ];
        for (const [label, path, opener] of states) {
          await browser.goto(`${baseUrl}${path}`, 900);
          await browser.evaluate(`document.querySelector(${JSON.stringify(opener)}).click()`);
          await new Promise((r) => setTimeout(r, 200));
          const m = await browser.evaluate<{ scrollWidth: number; open: boolean; small: string[]; moving: string[] }>(`
            (function () {
              var controls = Array.from(document.querySelectorAll('#agreement-body button, #agreement-body input, #agreement-body a.btn'))
                .filter(function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
              var small = controls.filter(function (el) { var r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; })
                .map(function (el) { var r = el.getBoundingClientRect(); return (el.id || el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
              var moving = Array.from(document.querySelectorAll('#terms > li, .line-edit'))
                .filter(function (el) { var s = getComputedStyle(el); return s.opacity !== '1' || parseFloat(s.transitionDuration) > 0; })
                .map(function (el) { return el.className || el.tagName; });
              return {
                scrollWidth: document.documentElement.scrollWidth,
                open: !!document.querySelector('.line-edit'),
                small: small, moving: moving
              };
            })()
          `);
          expect(m.open, `${label} at ${width} did not open`).toBe(true);
          expect(m.scrollWidth, `${label} at ${width} scrolls sideways`).toBe(width);
          if (touch) expect(m.small, `${label} at ${width}: controls under 44px`).toEqual([]);
          expect(m.moving, `${label} at ${width}: moving under reduced motion`).toEqual([]);
        }
      } finally {
        await browser.close();
      }
    }, 60_000);
  });
});
