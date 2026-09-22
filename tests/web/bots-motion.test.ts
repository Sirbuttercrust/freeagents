// Motion, measured in real Chrome on My agents (four rows, 40px bots) with
// the viewport short enough that only the first rows are on screen.
//
//   prefers-reduced-motion: reduce   no bot is on the frame loop, and a
//                                    bot's pixels do not change over a
//                                    second: the static end is the rest pose
//   no-preference, on screen         the bot is on the loop and its pixels
//                                    change (it breathes and blinks)
//   no-preference, off screen        the bot is off the loop; scrolling it
//                                    into view puts it back
//   the operator page head avatar    drawn still, never on the loop
//
// data-avatar-live is bots.js's own flag for "subscribed to the ticker"
// (src/web/public/js/bots.js sync()). The pixel comparison is the check
// that does not trust the flag.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import type { Session } from '../../src/adapters/identity/session.js';
import type { Delegation } from '../../src/domain/agent.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

let server: Server;
let baseUrl: string;
let session: Session;
let operatorDid: string;
const DIDS = Array.from({ length: 8 }, (_, i) => `did:abt:zMotion${i}`);

beforeAll(async () => {
  process.env.FREEAGENTS_PLATFORM_SEED ??= 'e'.repeat(64);
  const agentRepo = new MemoryAgentRepository();
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'motion-operator', id: 8802 }),
  });
  server = createApp(
    new MemoryAccountRepository(), agentRepo, undefined, undefined, new MemoryJobRepository(), undefined,
    undefined, new MemoryCredentialRepository(), undefined, undefined, undefined, sessionAdapter,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  session = await mintSession(sessionAdapter);
  const me = (await (await fetch(`${baseUrl}/accounts/me`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
  })).json()) as { did: string };
  operatorDid = me.did;
  for (const [i, did] of DIDS.entries()) {
    await agentRepo.create({
      did, operatorDid, delegation: {} as unknown as Delegation,
      name: `motion-${i}`, skills: ['triage'], githubLogin: null,
    });
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Per host: on the loop, on screen, and a hash of its pixels.
const SNAP = `
  [].map.call(document.querySelectorAll('.arow .rav'), function (h) {
    var c = h.querySelector('canvas.bot'), r = h.getBoundingClientRect();
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, s = 0;
    for (var i = 0; i < d.length; i += 7) s = (s * 31 + d[i]) >>> 0;
    return { live: h.hasAttribute('data-avatar-live'), visible: r.bottom > 0 && r.top < innerHeight, sum: s };
  })
`;
type Snap = Array<{ live: boolean; visible: boolean; sum: number }>;

// The same, for every mounted bot on any page.
const ANY_SNAP = SNAP.replace(".arow .rav", "[data-avatar]:has(> canvas.bot)");

// Counts animation-frame callbacks that actually run, from the first script.
const FRAME_COUNTER = `
  window.__frames = 0;
  (function (raf) {
    window.requestAnimationFrame = function (cb) {
      return raf.call(window, function (t) { window.__frames += 1; cb(t); });
    };
  })(window.requestAnimationFrame);
`;

async function open(motion: 'reduce' | 'no-preference', path = '/myagents'): Promise<RealBrowser> {
  const b = await RealBrowser.launch({ width: 1280, height: 420 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
  await b.goto(`${baseUrl}${path}`, 100);
  await b.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
  await b.goto(`${baseUrl}${path}`, 1500);
  return b;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('bots move only when they should', { timeout: 60000 }, () => {
  it('reduced motion: nothing is on the loop and no pixel changes over two seconds', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const b = await open('reduce');
    try {
      const a = await b.evaluate<Snap>(SNAP);
      await sleep(2000);
      const z = await b.evaluate<Snap>(SNAP);
      expect(a.length).toBe(DIDS.length);
      expect(a.filter((x) => x.live).length, 'a bot is on the frame loop under reduced motion').toBe(0);
      expect(z.map((x) => x.sum), 'a bot changed its pixels under reduced motion').toEqual(a.map((x) => x.sum));
    } finally {
      await b.close();
    }
  });

  it('no preference: on-screen bots animate, off-screen bots are off the loop until scrolled in', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const b = await open('no-preference');
    try {
      const a = await b.evaluate<Snap>(SNAP);
      // Idle life: breathing is continuous, so two seconds is plenty.
      await sleep(2000);
      const z = await b.evaluate<Snap>(SNAP);
      const on = a.map((x, i) => ({ ...x, i })).filter((x) => x.visible);
      const off = a.map((x, i) => ({ ...x, i })).filter((x) => !x.visible);
      expect(on.length, 'no row on screen, so this proves nothing').toBeGreaterThan(0);
      expect(off.length, 'every row on screen, so the pause is never exercised').toBeGreaterThan(0);
      for (const x of on) {
        expect(x.live, `row ${x.i} is on screen but off the loop`).toBe(true);
        expect(z[x.i]!.sum, `row ${x.i} is on the loop but its pixels never changed`).not.toBe(x.sum);
      }
      for (const x of off) {
        expect(x.live, `row ${x.i} is off screen but still on the loop`).toBe(false);
        expect(z[x.i]!.sum, `row ${x.i} is off screen but its pixels changed`).toBe(x.sum);
      }
      // Scroll the last row in; it joins the loop.
      await b.evaluate(`document.querySelectorAll('.arow .rav')[${DIDS.length - 1}].scrollIntoView({ block: 'center' })`);
      await sleep(400);
      const after = await b.evaluate<Snap>(SNAP);
      expect(after[DIDS.length - 1]!.live, 'scrolled into view but never rejoined the loop').toBe(true);
    } finally {
      await b.close();
    }
  });

  // Review round 1: the page claimed to follow the setting while open, and did not.
  // The bots stayed on the loop with their pixels changing nine seconds after
  // the switch. Every assertion here is taken AFTER the emulated media
  // changes, with no reload in between, and the frame counter is the check
  // that trusts neither the flag nor the pixels: if nothing asks for a frame,
  // nothing can repaint.
  for (const path of ['/myagents', () => `/agents/${encodeURIComponent(DIDS[0]!)}`] as const) {
    const label = typeof path === 'string' ? path : '/agents/:did';
    it(`${label}: switching to reduced motion while open takes every bot off the loop and back`, async () => {
      if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
      const b = await RealBrowser.launch({ width: 1280, height: 900 });
      try {
        await b.send('Page.addScriptToEvaluateOnNewDocument', { source: FRAME_COUNTER });
        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        const url = `${baseUrl}${typeof path === 'string' ? path : path()}`;
        await b.goto(url, 100);
        await b.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
        await b.goto(url, 1500);

        const before = await b.evaluate<Snap>(ANY_SNAP);
        expect(before.filter((x) => x.live).length, 'no bot was on the loop before the switch, so this proves nothing').toBeGreaterThan(0);

        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await sleep(300);
        expect(await b.evaluate<boolean>('FABots.reduced()'), 'the emulated switch did not reach the page').toBe(true);
        const a = await b.evaluate<Snap>(ANY_SNAP);
        const framesA = await b.evaluate<number>('window.__frames');
        await sleep(2000);
        const z = await b.evaluate<Snap>(ANY_SNAP);
        const framesZ = await b.evaluate<number>('window.__frames');
        expect(a.filter((x) => x.live).length, 'a bot stayed on the frame loop after the switch').toBe(0);
        expect(z.map((x) => x.sum), 'a bot kept repainting after the switch').toEqual(a.map((x) => x.sum));
        expect(framesZ - framesA, 'something still asks for animation frames after the switch').toBe(0);

        // And back: an on-screen bot resumes its idle life.
        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        await sleep(300);
        const back = await b.evaluate<Snap>(ANY_SNAP);
        expect(back.filter((x) => x.live).length, 'no bot came back to life after motion was allowed again')
          .toBe(before.filter((x) => x.live).length);
      } finally {
        await b.close();
      }
    });
  }

  it('the operator\u2019s own mark is drawn still even with motion allowed', async () => {
    if (!hasRealBrowser()) return console.warn('no Chrome found; skipping (see CHROME_BIN)');
    const b = await open('no-preference', `/accounts/${encodeURIComponent(operatorDid)}`);
    try {
      const head = await b.evaluate<{ still: boolean; live: boolean; canvas: boolean }>(`
        (function () {
          var h = document.querySelector('[data-avatar="${operatorDid}"]');
          return { still: !!h && h.getAttribute('data-avatar-still') === 'true',
                   live: !!h && h.hasAttribute('data-avatar-live'),
                   canvas: !!h && !!h.querySelector('canvas.bot') };
        })()
      `);
      expect(head).toEqual({ still: true, live: false, canvas: true });
    } finally {
      await b.close();
    }
  });
});
