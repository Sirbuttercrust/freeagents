// The three payout boxes on /settings: USDC on Arbitrum, ABT on Ethereum and
// ABT on ArcBlock, each in its own box labelled with its token and network.
// The owner says they control the wallet before a changed box saves, a
// contract address is warned in plain words before it saves, and a refusal
// names the box in its label's words.
//
// Driven through the real app: GET /accounts/me and
// PATCH /accounts/:did/operator-address answer for real, with the session
// adapter. The contract-code question is createApp's last parameter; the
// default asks no node in tests and answers "could not tell", so a save goes
// through, and the 409 world hands in a check that answers "contract code".
// Every expected value is a literal or read from the route, never from the
// page under test.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { checksumOk } from '../../src/adapters/payment/evm-address-lookup.js';
import type { OperatorAddressCheck } from '../../src/adapters/payment/operator-address-check.js';
import { MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const BROWSER_TIMEOUT_MS = 60_000;
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PLATFORM_SEED = 'e'.repeat(64);

const ARB = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const ETH = '0xAb12AB12Ab12AB12ab12Ab12ab12aB12AB12aB12';
const ETH_SECOND = '0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12';
// ETH with its first letter's case flipped: the right shape, a failing checksum.
const ETH_MISTYPED = '0xab12AB12Ab12AB12ab12Ab12ab12aB12AB12aB12';
const ABT = 'z6MkExampleSuffix';
const CONTRACT_SENTENCE_ETH =
  'This address on Ethereum holds contract code, so it may be a contract and not an ordinary wallet. ABT sent to a contract only arrives if the contract was built to receive it. Check the address in your wallet before you save it.';

interface World {
  server: Server;
  baseUrl: string;
  repo: MemoryAccountRepository;
  session: Session;
  did: string;
}

const worlds: World[] = [];

// contract: true hands createApp a check that reads the real checksum and
// answers "holds contract code" for every address; false leaves the default.
async function startWorld(contract = false): Promise<World> {
  const repo = new MemoryAccountRepository();
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'payout-boxes-owner', id: 9911 }),
  });
  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = repo;
  args[11] = sessionAdapter;
  if (contract) {
    const check: OperatorAddressCheck = {
      async check(_network, address) {
        return { checksumOk: checksumOk(address), holdsContractCode: true };
      },
    };
    args[28] = check;
  }
  const app = createApp(...(args as Parameters<typeof createApp>));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await mintSession(sessionAdapter);
  const me = (await (await fetch(`${baseUrl}/accounts/me`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
  })).json()) as { did: string };
  const world = { server, baseUrl, repo, session, did: me.did };
  worlds.push(world);
  return world;
}

interface Page {
  window: JSDOM['window'];
  document: Document;
  patches: () => Array<Record<string, unknown>>;
  input: (id: string) => HTMLInputElement;
  type: (id: string, value: string) => void;
  tick: (id: string) => void;
  save: () => void;
  shown: (id: string) => boolean;
  text: (id: string) => string;
  close: () => void;
}

// gate.wait: while it holds a promise, a PATCH waits on it before it reaches
// the route. Read at the moment of each call, so a test can hold one press.
interface Gate { wait: Promise<void> | null }

async function render(world: World, gate: Gate = { wait: null }): Promise<Page> {
  const virtualConsole = new VirtualConsole();
  const failures: string[] = [];
  virtualConsole.on('jsdomError', (error: Error) => failures.push(error.message));
  const markup = await (await fetch(`${world.baseUrl}/settings`, { headers: { Accept: HTML } })).text();
  const calls: Array<{ method: string; body: string }> = [];
  const dom = new JSDOM(markup, {
    url: `${world.baseUrl}/settings`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.sessionStorage.setItem('fa_session', JSON.stringify(world.session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: async (input: string, init?: RequestInit) => {
          calls.push({ method: init?.method ?? 'GET', body: String(init?.body ?? '') });
          if (init?.method === 'PATCH' && gate.wait !== null) await gate.wait;
          return fetch(new URL(input, world.baseUrl), init);
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  await until(() => !(dom.window.document.getElementById('settings-body') as HTMLElement).hidden);
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  const doc = dom.window.document;
  const el = (id: string) => {
    const found = doc.getElementById(id);
    if (found === null) throw new Error(`#${id} is missing`);
    return found;
  };
  return {
    window: dom.window,
    document: doc,
    patches: () => calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body) as Record<string, unknown>),
    input: (id) => el(id) as HTMLInputElement,
    type: (id, value) => {
      const box = el(id) as HTMLInputElement;
      box.value = value;
      box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
    tick: (id) => (el(id) as HTMLInputElement).click(),
    save: () => (el('save-btn') as HTMLButtonElement).click(),
    shown: (id) => el(id).closest('[hidden]') === null,
    text: (id) => (el(id).textContent ?? '').replace(/\s+/g, ' ').trim(),
    close: () => dom.window.close(),
  };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the page');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stored(world: World): Promise<{ evm: string | null; abtEth: string | null; abt: string | null }> {
  const row = await world.repo.findByDid(world.did);
  if (row === null) throw new Error('no row');
  return { evm: row.operatorAddressEvm, abtEth: row.operatorAddressAbtEth, abt: row.operatorAddressAbt };
}

const CONFIRMS = ['payout-evm-confirm', 'payout-abt-eth-confirm', 'payout-abt-confirm'];

let originalSeed: string | undefined;
beforeAll(() => {
  originalSeed = process.env.FREEAGENTS_PLATFORM_SEED;
  process.env.FREEAGENTS_PLATFORM_SEED = PLATFORM_SEED;
});
afterEach(async () => {
  for (const w of worlds.splice(0)) await new Promise<void>((resolve) => w.server.close(() => resolve()));
});
afterAll(() => {
  if (originalSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
  else process.env.FREEAGENTS_PLATFORM_SEED = originalSeed;
});

describe('/settings, the three payout boxes', () => {
  it('(a) three boxes in order, each labelled with token and network, one line on what it accepts, tied by aria-describedby, prefilled from GET /accounts/me', async () => {
    const w = await startWorld();
    await w.repo.setOperatorAddressEvm(w.did, ARB);
    await w.repo.setOperatorAddressAbtEth(w.did, ETH);
    await w.repo.setOperatorAddressAbt(w.did, ABT);
    const page = await render(w);
    try {
      const boxes = Array.from(page.document.querySelectorAll('#settings-body .field input.input')).map((input) => {
        const box = input as HTMLInputElement;
        const hintId = box.getAttribute('aria-describedby') ?? '';
        return {
          id: box.id,
          label: (page.document.querySelector(`label[for="${box.id}"]`)?.textContent ?? '').trim(),
          hintId,
          hint: (page.document.getElementById(hintId)?.textContent ?? '').trim(),
          value: box.value,
          autocapitalize: box.getAttribute('autocapitalize'),
          autocorrect: box.getAttribute('autocorrect'),
          spellcheck: box.getAttribute('spellcheck'),
        };
      });
      const attrs = { autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' };
      expect(boxes).toEqual([
        { id: 'payout-evm', label: 'Paid in USDC, on Arbitrum', hintId: 'payout-evm-hint', hint: 'Only an address that can receive USDC on Arbitrum.', value: ARB, ...attrs },
        { id: 'payout-abt-eth', label: 'Paid in ABT, on Ethereum', hintId: 'payout-abt-eth-hint', hint: "Only an address that can receive ABT on Ethereum. Exchange deposit addresses usually can't.", value: ETH, ...attrs },
        { id: 'payout-abt', label: 'Paid in ABT, on ArcBlock', hintId: 'payout-abt-hint', hint: 'Only an address that can receive ABT on ArcBlock.', value: ABT, ...attrs },
      ]);
    } finally {
      page.close();
    }
  });

  it('(a) an account with only the USDC address set shows the Ethereum and ArcBlock boxes empty', async () => {
    const w = await startWorld();
    await w.repo.setOperatorAddressEvm(w.did, ARB);
    const page = await render(w);
    try {
      expect(['payout-evm', 'payout-abt-eth', 'payout-abt'].map((id) => page.input(id).value)).toEqual([ARB, '', '']);
    } finally {
      page.close();
    }
  });

  it('(b) no confirmation on load; editing the Ethereum box shows exactly its own, unticked, with its words; the saved value put back hides it', async () => {
    const w = await startWorld();
    await w.repo.setOperatorAddressAbtEth(w.did, ETH);
    const page = await render(w);
    try {
      expect(CONFIRMS.map((id) => page.shown(id))).toEqual([false, false, false]);
      page.type('payout-abt-eth', ETH_SECOND);
      expect(CONFIRMS.map((id) => page.shown(id))).toEqual([false, true, false]);
      expect(page.input('payout-abt-eth-confirm').checked).toBe(false);
      expect((page.input('payout-abt-eth-confirm').closest('label')?.textContent ?? '').trim()).toBe('I control this wallet on Ethereum');
      page.type('payout-abt-eth', ETH);
      expect(CONFIRMS.map((id) => page.shown(id))).toEqual([false, false, false]);
    } finally {
      page.close();
    }
  });

  it('(b) each box shows its own confirmation in its own network words, and it is unticked each time it appears and after any edit to its box', async () => {
    const w = await startWorld();
    const page = await render(w);
    try {
      page.type('payout-evm', ARB);
      page.type('payout-abt', ABT);
      const words = ['payout-evm-confirm', 'payout-abt-confirm'].map((id) => (page.input(id).closest('label')?.textContent ?? '').trim());
      expect(words).toEqual(['I control this wallet on Arbitrum', 'I control this wallet on ArcBlock']);
      page.tick('payout-abt-confirm');
      expect(page.input('payout-abt-confirm').checked).toBe(true);
      page.type('payout-abt', ABT + 'x');
      expect(page.input('payout-abt-confirm').checked).toBe(false);
      page.tick('payout-abt-confirm');
      page.type('payout-abt', '');
      page.type('payout-abt', ABT);
      expect([page.shown('payout-abt-confirm'), page.input('payout-abt-confirm').checked]).toEqual([true, false]);
    } finally {
      page.close();
    }
  });

  it('(c) Save with a changed, unticked box sends no PATCH, names that box and its confirmation, and the message takes focus', async () => {
    const w = await startWorld();
    const page = await render(w);
    try {
      page.type('payout-abt-eth', ETH);
      page.type('payout-abt', ABT);
      page.tick('payout-abt-confirm');
      page.save();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(page.patches()).toEqual([]);
      expect(page.shown('save-error')).toBe(true);
      expect(page.text('save-error-detail')).toBe('Tick "I control this wallet on Ethereum" to save the ABT on Ethereum address.');
      expect(page.document.activeElement?.id).toBe('save-error');
      expect(await stored(w)).toEqual({ evm: null, abtEth: null, abt: null });
    } finally {
      page.close();
    }
  });

  it('(d) ticked, Save sends one PATCH whose whole body is the Ethereum address; "Saved." takes focus, the confirmation hides, and GET /accounts/me answers it with the USDC address unchanged', async () => {
    const w = await startWorld();
    await w.repo.setOperatorAddressEvm(w.did, ARB);
    const createdAt = ((await w.repo.findByDid(w.did)) as { createdAt: Date }).createdAt.toISOString();
    const page = await render(w);
    try {
      page.type('payout-abt-eth', ETH);
      page.tick('payout-abt-eth-confirm');
      page.save();
      await until(() => page.shown('save-success'));
      expect(page.patches()).toEqual([{ operatorAddressAbtEth: ETH }]);
      expect(page.text('save-success')).toBe('Saved.');
      expect(page.document.activeElement?.id).toBe('save-success');
      expect(CONFIRMS.map((id) => page.shown(id))).toEqual([false, false, false]);
      const me = await (await fetch(`${w.baseUrl}/accounts/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${w.session.token}` },
      })).json();
      expect(me).toEqual({
        did: w.did,
        githubLogin: 'payout-boxes-owner',
        createdAt,
        operatorAddressEvm: ARB,
        operatorAddressAbt: null,
        operatorAddressAbtEth: ETH,
        passkeySubject: null,
      });
    } finally {
      page.close();
    }
  });

  it('(e) a contract address: the route sentence shows with "Save it anyway", nothing saves; the press sends the same body plus confirmContractAddress and saves', async () => {
    const w = await startWorld(true);
    const page = await render(w);
    try {
      page.type('payout-abt-eth', ETH);
      page.tick('payout-abt-eth-confirm');
      page.save();
      await until(() => page.shown('save-warning'));
      expect(page.text('save-warning-detail')).toBe(CONTRACT_SENTENCE_ETH);
      expect(page.text('save-anyway')).toBe('Save it anyway');
      expect(page.document.getElementById('save-anyway')?.className).toBe('btn');
      expect(page.document.activeElement?.id).toBe('save-warning');
      expect(page.shown('save-success')).toBe(false);
      expect(await stored(w)).toEqual({ evm: null, abtEth: null, abt: null });

      (page.document.getElementById('save-anyway') as HTMLButtonElement).click();
      await until(() => page.shown('save-success'));
      expect(page.patches()).toEqual([
        { operatorAddressAbtEth: ETH },
        { operatorAddressAbtEth: ETH, confirmContractAddress: true },
      ]);
      expect(page.shown('save-warning')).toBe(false);
      expect(page.document.activeElement?.id).toBe('save-success');
      expect(await stored(w)).toEqual({ evm: null, abtEth: ETH, abt: null });
    } finally {
      page.close();
    }
  });

  it('(e) an edit to any box after the warning hides it and its button, and the next Save sends the new body without the flag', async () => {
    const w = await startWorld(true);
    const page = await render(w);
    try {
      page.type('payout-abt-eth', ETH);
      page.tick('payout-abt-eth-confirm');
      page.save();
      await until(() => page.shown('save-warning'));
      page.type('payout-abt', ABT);
      expect([page.shown('save-warning'), page.shown('save-anyway')]).toEqual([false, false]);
      page.tick('payout-abt-confirm');
      page.save();
      await until(() => page.patches().length === 2 && page.shown('save-warning'));
      expect(page.patches()).toEqual([
        { operatorAddressAbtEth: ETH },
        { operatorAddressAbtEth: ETH, operatorAddressAbt: ABT },
      ]);
      expect(await stored(w)).toEqual({ evm: null, abtEth: null, abt: null });
    } finally {
      page.close();
    }
  });

  it.each([
    ['payout-evm', 'not-an-address', 'The USDC on Arbitrum address is not a valid address. Copy it from your wallet again.'],
    ['payout-abt-eth', 'not-an-address', 'The ABT on Ethereum address is not a valid address. Copy it from your wallet again.'],
    ['payout-abt-eth', ETH_MISTYPED, 'The ABT on Ethereum address is not a valid address. Copy it from your wallet again.'],
    ['payout-abt', 'did:abt:z6MkExampleSuffix', 'The ABT on ArcBlock address is not a valid address. Copy it from your wallet again.'],
  ])('(f) a 400 on %s (%s) names the box in its label words, with no field name and no pattern, and the typed value stays', async (id, typed, sentence) => {
    const w = await startWorld();
    const page = await render(w);
    try {
      page.type(id, typed);
      page.tick(`${id}-confirm`);
      page.save();
      await until(() => page.shown('save-error'));
      expect(page.patches().length).toBe(1);
      expect(page.text('save-error-detail')).toBe(sentence);
      expect(page.document.activeElement?.id).toBe('save-error');
      expect(page.input(id).value).toBe(typed);
    } finally {
      page.close();
    }
  });

  it('(f) emptying a saved box sends nothing and says the address can only be replaced', async () => {
    const w = await startWorld();
    await w.repo.setOperatorAddressAbt(w.did, ABT);
    const page = await render(w);
    try {
      page.type('payout-abt', '');
      expect(page.shown('payout-abt-confirm')).toBe(false);
      page.save();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(page.patches()).toEqual([]);
      expect(page.text('save-error-detail')).toBe('A saved address can be replaced but not removed. Paste the new ABT on ArcBlock address to save it.');
      expect(page.document.activeElement?.id).toBe('save-error');
    } finally {
      page.close();
    }
  });

  it('(g) mid-flight the Save button is aria-disabled, never disabled, keeps focus, and a second press sends no second PATCH', async () => {
    const w = await startWorld();
    let release: () => void = () => undefined;
    const gate: Gate = { wait: new Promise<void>((resolve) => { release = resolve; }) };
    const page = await render(w, gate);
    try {
      page.type('payout-evm', ARB);
      page.tick('payout-evm-confirm');
      const btn = page.document.getElementById('save-btn') as HTMLButtonElement;
      btn.focus();
      page.save();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect([btn.getAttribute('aria-disabled'), btn.disabled, page.document.activeElement?.id]).toEqual(['true', false, 'save-btn']);
      page.save();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(page.patches()).toEqual([{ operatorAddressEvm: ARB }]);
      release();
      await until(() => page.shown('save-success'));
      expect(btn.getAttribute('aria-disabled')).toBe(null);
      expect(page.patches()).toEqual([{ operatorAddressEvm: ARB }]);
    } finally {
      release();
      page.close();
    }
  });

  it('(g) "Save it anyway" is aria-disabled in flight, never disabled, and a second press sends nothing more', async () => {
    const w = await startWorld(true);
    const gate: Gate = { wait: null };
    const page = await render(w, gate);
    let release: () => void = () => undefined;
    try {
      page.type('payout-abt-eth', ETH);
      page.tick('payout-abt-eth-confirm');
      page.save();
      await until(() => page.shown('save-warning'));
      gate.wait = new Promise<void>((resolve) => { release = resolve; });
      const anyway = page.document.getElementById('save-anyway') as HTMLButtonElement;
      anyway.focus();
      anyway.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect([anyway.getAttribute('aria-disabled'), anyway.disabled, page.document.activeElement?.id]).toEqual(['true', false, 'save-anyway']);
      anyway.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await until(() => page.shown('save-success'));
      expect(page.patches()).toEqual([
        { operatorAddressAbtEth: ETH },
        { operatorAddressAbtEth: ETH, confirmContractAddress: true },
      ]);
    } finally {
      release();
      page.close();
    }
  });
});

describe('/settings payout boxes at 320px in real Chrome', () => {
  async function measure(browser: RealBrowser): Promise<{ scroll: [number, number]; small: unknown[]; boxes: unknown[] }> {
    return browser.evaluate(`(() => {
      const seen = (el) => el.offsetParent !== null && el.closest('[hidden]') === null;
      const all = Array.from(document.querySelectorAll('#settings-body a, #settings-body button, #settings-body input, #settings-body label')).filter(seen);
      const small = all
        .filter((el) => !(el.tagName === 'INPUT' && el.type === 'checkbox' && el.closest('label')))
        .filter((el) => el.tagName !== 'LABEL' || el.querySelector('input[type="checkbox"]'))
        .map((el) => { const r = el.getBoundingClientRect(); return [el.id || el.tagName + ' ' + el.textContent.trim(), Math.round(r.width), Math.round(r.height)]; })
        .filter(([, w, h]) => w < 44 || h < 44);
      const boxes = all.filter((el) => el.type === 'checkbox').map((el) => el.id);
      return { scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth], small, boxes };
    })()`);
  }

  async function open(w: World): Promise<RealBrowser> {
    const browser = await RealBrowser.launch({ width: 320, height: 900 });
    await browser.goto(`${w.baseUrl}/settings`);
    await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(w.session))})`);
    await browser.goto(`${w.baseUrl}/settings`);
    return browser;
  }

  const typeAll = `(() => {
    for (const [id, v] of [['payout-evm', '${ARB}'], ['payout-abt-eth', '${ETH}'], ['payout-abt', '${ABT}']]) {
      const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`;

  it('(h) every confirmation shown: no sideways scroll, every control 44px, each checkbox exempt only through a label that clears 44px', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const w = await startWorld();
    const browser = await open(w);
    try {
      await browser.evaluate(typeAll);
      const m = await measure(browser);
      expect(m).toEqual({ scroll: [320, 320], small: [], boxes: CONFIRMS });
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);

  it('(h) the contract warning shown: no sideways scroll and every control 44px', async () => {
    if (!hasRealBrowser()) {
      console.warn('no Chrome found for real-browser layout test; skipping (see CHROME_BIN)');
      return;
    }
    const w = await startWorld(true);
    const browser = await open(w);
    try {
      await browser.evaluate(typeAll);
      await browser.evaluate(`(() => { for (const id of ${JSON.stringify(CONFIRMS)}) document.getElementById(id).click(); document.getElementById('save-btn').click(); })()`);
      const deadline = Date.now() + 10_000;
      while (!(await browser.evaluate<boolean>(`document.getElementById('save-warning') !== null && !document.getElementById('save-warning').hidden`))) {
        if (Date.now() > deadline) throw new Error('the warning never showed');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const m = await measure(browser);
      expect(m).toEqual({ scroll: [320, 320], small: [], boxes: CONFIRMS });
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
