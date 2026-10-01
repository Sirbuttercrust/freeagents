// The /conduct diagram (DIAG1c), measured in a real browser against
// createApp(), the way tests/web/diagrams.test.ts measures /outcomes and
// tests/web/how-diagrams.test.ts measures /how. tests/web/conduct.test.ts
// keeps the page's data pins (four states, eight counts field by field,
// no score, markup as text, no avatar); this file holds what the diagram
// adds on top of them.
//
// "The finished picture" is read, never written down: it is the same page
// loaded with ?still in the same browser at the same size.
//
//   (a) the diagram waits for the read, plays once as it comes into view,
//       ends on the response's eight values field by field; Replay replays
//   (b) reduced motion: final values at once, never counted, nothing moves;
//       scripts off: the page says so and shows no number
//   (c) every word in the diagram meets AA at ?t=0, mid count-up and at
//       the end, on painted pixels
//   (d) the cold start: eight "0" leaves, both branches, nothing hidden
//   (e) keyed: false, 404, 503 and a network failure: today's sentence and
//       no diagram node that carries a number
//   (f) both disclosures closed at load, each opens to main's words
//   (g) no sample numbers: no demo parameter, no "Sample numbers", no
//       number or account name in what the server ships
//   (h) 320, 390 and 1280 on a touch profile: no sideways scroll, 44 px
//       controls, branches side by side on a computer, stacked on a phone
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';

const T_MS = 90_000;
const BUYER_DID = 'did:abt:conduct-diagram-buyer';
const BUYER = 'conduct-diagram-buyer';
const COLD = 'conduct-diagram-cold';
const AGENT_DID = 'did:abt:conduct-diagram-agent';
const OWN_AGENT_DID = 'did:abt:conduct-diagram-own-agent';
const OTHER_BUYER = 'did:abt:conduct-diagram-other-buyer';

// Leaf id -> the response field it shows, in page order.
const FIELDS: Array<[string, 'counts' | 'operatorCounts', string]> = [
  ['ct-confirmed', 'counts', 'confirmed'],
  ['ct-merged', 'counts', 'merged'],
  ['ct-deemed', 'counts', 'deemed'],
  ['ct-cited-closes', 'counts', 'citedCloses'],
  ['ct-redos-requested', 'counts', 'redosRequested'],
  ['ct-walked-away', 'counts', 'walkedAway'],
  ['ct-delivered-never-paid', 'operatorCounts', 'deliveredNeverPaid'],
  ['ct-redos-refused', 'operatorCounts', 'redosRefused'],
];
const IDS = FIELDS.map(([id]) => id);

let server: Server;
let baseUrl: string;
let expected: Record<string, string>;

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${agentDid}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture-not-verified-here' },
  };
}

beforeAll(async () => {
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: BUYER_DID, githubLogin: BUYER });
  await accounts.register({ did: 'did:abt:conduct-diagram-operator', githubLogin: 'conduct-diagram-operator' });
  await accounts.register({ did: 'did:abt:conduct-diagram-cold', githubLogin: COLD });
  const agents = new MemoryAgentRepository();
  await agents.create({ did: AGENT_DID, operatorDid: 'did:abt:conduct-diagram-operator', delegation: delegation(AGENT_DID, 'did:abt:conduct-diagram-operator'), name: 'conduct-diagram-agent', skills: ['triage'], githubLogin: null });
  await agents.create({ did: OWN_AGENT_DID, operatorDid: BUYER_DID, delegation: delegation(OWN_AGENT_DID, BUYER_DID), name: 'conduct-diagram-own', skills: ['triage'], githubLogin: null });
  const jobs = new MemoryJobRepository();
  const at = new Date('2026-08-02T00:00:00Z');
  let n = 0;
  const job = async (buyer: string, agent: string, o: Partial<Job>) => {
    const base = createJob({ id: `conduct-diagram-${n++}`, buyerDid: buyer, agentDid: agent, repository: 'buyer/repo', brief: 'b' }, new Date('2026-08-01T00:00:00Z'));
    await jobs.create({ ...base, confirmedAt: at, ...o });
  };
  // Eight different numbers, so a leaf bound to the wrong field cannot
  // pass by coincidence: confirmed 11, merged 5, deemed 1, citedCloses 2,
  // redosRequested 4, walkedAway 3, deliveredNeverPaid 7, redosRefused 6.
  for (let i = 0; i < 5; i++) await job(BUYER_DID, AGENT_DID, { status: 'completed', mergeCommit: 'c', mergedAt: at, ...(i < 2 ? { redoRequestedAt: at } : {}) });
  await job(BUYER_DID, AGENT_DID, { status: 'deemed_completed', deemedCompletedAt: at });
  for (let i = 0; i < 2; i++) await job(BUYER_DID, AGENT_DID, { status: 'cited_closed', citedCloseAt: at, ...(i === 0 ? { redoRequestedAt: at } : {}) });
  for (let i = 0; i < 2; i++) await job(BUYER_DID, AGENT_DID, { status: 'staged_declined', ...(i === 0 ? { redoRequestedAt: at } : {}) });
  await job(BUYER_DID, AGENT_DID, { status: 'closed_unpaid' });
  for (let i = 0; i < 6; i++) await job(OTHER_BUYER, OWN_AGENT_DID, { status: 'staged_declined', redoRequestedAt: at, redoRefusedAt: at });
  await job(OTHER_BUYER, OWN_AGENT_DID, { status: 'closed_unpaid' });

  server = createApp(accounts, agents, undefined, undefined, jobs).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The expected numbers are read from the route itself, so every pin
  // below binds the page to the response rather than to a copy of it.
  const body = (await (await fetch(`${baseUrl}/buyers/${BUYER}/conduct`)).json()) as Record<string, Record<string, number>>;
  expected = Object.fromEntries(FIELDS.map(([id, side, field]) => [id, String(body[side]?.[field])]));
  expect(Object.values(expected), 'the fixture gives eight different numbers').toEqual(['11', '5', '1', '2', '4', '3', '7', '6']);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const page = (login: string, q = '') => `${baseUrl}/conduct?account=${encodeURIComponent(login)}${q}`;

interface Opts { width: number; height: number; touch?: boolean; init?: string; reduce?: boolean }
async function openBrowser(o: Opts): Promise<RealBrowser> {
  const b = await RealBrowser.launch({ width: o.width, height: o.height });
  if (o.touch) {
    await b.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 2, mobile: true, screenOrientation: { angle: 0, type: 'portraitPrimary' } });
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: o.reduce ? 'reduce' : 'no-preference' }] });
  if (o.init) await b.send('Page.addScriptToEvaluateOnNewDocument', { source: o.init });
  return b;
}

function skipWithoutChrome(): boolean {
  if (hasRealBrowser()) return false;
  console.warn('no Chrome found for the /conduct diagram tests; skipping (see CHROME_BIN)');
  return true;
}

// One string per node, wire, number and strike. Two states are the same
// picture exactly when these are equal.
interface State { nodes: string[]; wires: string[]; nums: string[]; strikes: string[]; replayShown: boolean; built: boolean }
const STATE = `
  (function () {
    function cs(e) { return getComputedStyle(e); }
    var d = document.getElementById('conduct-diagram'), replay = d.querySelector('.dg-replay');
    return {
      nodes: Array.from(d.querySelectorAll('.dg-node')).map(function (n) {
        var h = n.querySelector('h3, .l') || n;
        return [n.getAttribute('data-id'), cs(n).opacity, cs(n).transform, cs(n).boxShadow, cs(h).color].join('|');
      }),
      wires: Array.from(d.querySelectorAll('.dg-wires .dg-wire')).map(function (w) { return cs(w).strokeDashoffset; }),
      nums: Array.from(d.querySelectorAll('.dg-leaf .n')).map(function (n) { return n.id + '=' + n.textContent + '|' + cs(n).color; }),
      strikes: Array.from(d.querySelectorAll('.dg-strike path')).map(function (p) { return cs(p).strokeDashoffset; }),
      replayShown: !!replay && !replay.hidden && cs(replay).display !== 'none',
      built: !!d.querySelector('.dg-wires')
    };
  })()
`;
type Picture = Omit<State, 'replayShown' | 'built'>;
const picture = (s: State): Picture => ({ nodes: s.nodes, wires: s.wires, nums: s.nums, strikes: s.strikes });
const state = (b: RealBrowser) => b.evaluate<State>(STATE);
const numbers = (b: RealBrowser) => b.evaluate<Record<string, string>>(`
  Object.fromEntries(Array.from(document.querySelectorAll('.dg-leaf .n')).map(function (n) { return [n.id, n.textContent]; }))
`);

async function reference(b: RealBrowser, login = BUYER): Promise<Picture> {
  await b.goto(page(login, '&still'), 300);
  // The diagram is set up only once the read lands, so wait for it.
  const until = Date.now() + 8000;
  let s = await state(b);
  while (!s.built && Date.now() < until) { await sleep(150); s = await state(b); }
  const ref = picture(s);
  expect(ref.nodes.length, 'the root, two branch heads, eight leaves and three plates').toBe(14);
  expect(ref.wires.length, 'a wire to each branch head and to each leaf').toBe(10);
  return ref;
}

// Scrolls as a reader finishing the diagram would: the disclosures under
// it to the middle of the screen, so the three plates, its last nodes,
// sit well inside the screen and the clock never waits on one of them.
const toEnd = (b: RealBrowser) => b.evaluate("document.querySelector('main .dg-more').scrollIntoView({ block: 'center' })");

async function waitFinished(b: RealBrowser, ms: number): Promise<State> {
  const until = Date.now() + ms;
  let s = await state(b);
  while (Date.now() < until && !s.replayShown) { await sleep(250); s = await state(b); }
  return s;
}

// A real click at the element's centre, so a covered control would miss.
async function clickCentre(b: RealBrowser, expr: string): Promise<void> {
  await b.evaluate(`(${expr}).scrollIntoView({ block: 'center' })`);
  await sleep(150);
  const q = await b.evaluate<{ x: number; y: number }>(`(function () { var r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'left', clickCount: 1 });
}

// Holds the page's one read back for 1.5 s, and records the moment the
// diagram is first set up (its wires are inserted): whether the read had
// landed by then, and what each leaf held.
const HOLD = `(function () {
  var f = window.fetch; window.__read = 'none'; window.__reads = 0;
  window.fetch = function (u, o) {
    if (String(u).indexOf('/buyers/') < 0) return f.call(window, u, o);
    window.__reads++; window.__read = 'pending';
    return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return f.call(window, u, o); })
      .then(function (res) { window.__read = 'done'; return res; });
  };
  new MutationObserver(function () {
    if (window.__setUp || !document.querySelector('#conduct-diagram .dg-wires')) return;
    window.__setUp = { read: window.__read, shown: !document.getElementById('conduct-body').hidden,
      nums: Object.fromEntries(Array.from(document.querySelectorAll('.dg-leaf .n')).map(function (n) { return [n.id, n.getAttribute('data-n')]; })) };
  }).observe(document, { childList: true, subtree: true });
})();`;

describe('(a) the diagram waits for the read, plays once as it comes into view, and ends on the response\u2019s eight values', () => {
  it('nothing is built or numbered while the read is out; it is set up only after all eight numbers are written; the lower leaves wait below the fold; it ends on each field\u2019s value; scrolling back moves nothing; Replay replays', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 390, height: 844, init: HOLD });
    try {
      const ref = await reference(b);
      await b.goto(page(BUYER), 700);
      const waiting = await b.evaluate<{ read: string; built: boolean; bodyHidden: boolean; texts: string[] }>(`({ read: window.__read, built: !!document.querySelector('.dg-wires'),
        bodyHidden: document.getElementById('conduct-body').hidden, texts: Array.from(document.querySelectorAll('.dg-leaf .n')).map(function (n) { return n.textContent; }) })`);
      expect(waiting, 'while the read is out: no diagram built, the body hidden, no number anywhere').toEqual({ read: 'pending', built: false, bodyHidden: true, texts: Array(8).fill('') });

      await sleep(1600);
      const setUp = await b.evaluate<{ read: string; shown: boolean; nums: Record<string, string> } | undefined>('window.__setUp');
      expect(setUp, 'the diagram was set up after the read landed, with the body shown and every number written').toEqual({ read: 'done', shown: true, nums: expected });
      expect(await b.evaluate<number>('window.__reads'), 'exactly one read').toBe(1);

      await sleep(2500);
      const early = await state(b);
      expect(early.replayShown, 'not finished while its lower leaves are below the fold').toBe(false);
      const below = await b.evaluate<Array<[string, string]>>(`Array.from(document.querySelectorAll('#operator-counts .n')).map(function (n) { return [n.id, n.textContent]; })`);
      expect(below, 'the two leaves nobody has scrolled to have not counted').toEqual([['ct-delivered-never-paid', ''], ['ct-redos-refused', '']]);

      await toEnd(b);
      const done = await waitFinished(b, 20_000);
      expect(done.replayShown, 'it finishes and offers Replay').toBe(true);
      expect(await numbers(b), 'each leaf ends on its field\u2019s value').toEqual(expected);
      expect(picture(done), 'the finished picture').toEqual(ref);
      for (const y of ['0', 'document.documentElement.scrollHeight', '0']) {
        await b.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(500);
        expect(picture(await state(b)), `unchanged after scrolling to ${y}: it played once`).toEqual(ref);
      }

      await clickCentre(b, "document.querySelector('#conduct-diagram .dg-replay')");
      await sleep(300);
      const again = await state(b);
      expect(picture(again), 'Replay starts it again').not.toEqual(ref);
      expect(again.replayShown, 'Replay hides itself while it plays').toBe(false);
      await toEnd(b);
      const redone = await waitFinished(b, 20_000);
      expect(picture(redone), 'and ends on the finished picture again').toEqual(ref);
      expect(await numbers(b)).toEqual(expected);
    } finally {
      await b.close();
    }
  }, T_MS);
});

// Every text each leaf's number ever held, from load.
const HISTORY = `(function () {
  window.__hist = {};
  new MutationObserver(function (list) {
    list.forEach(function (m) {
      var n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      n = n && n.closest ? n.closest('.dg-leaf .n') : null;
      if (!n) return;
      var h = window.__hist[n.id] = window.__hist[n.id] || [];
      if (h[h.length - 1] !== n.textContent) h.push(n.textContent);
    });
  }).observe(document, { childList: true, subtree: true, characterData: true });
})();`;

describe('(b) reduced motion shows the final values at once and nothing moves; scripts off shows no number', () => {
  it('reduced motion: each leaf only ever held its final value, the picture is the finished one at load and after scrolling, no Replay', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 390, height: 844, init: HISTORY });
    try {
      const ref = await reference(b);
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await b.goto(page(BUYER), 800);
      const s0 = await state(b);
      expect(picture(s0), 'the finished picture at load').toEqual(ref);
      expect(s0.replayShown, 'nothing to replay').toBe(false);
      const hist = await b.evaluate<Record<string, string[]>>('window.__hist');
      expect(hist, 'no leaf counted: each held only its final value').toEqual(Object.fromEntries(IDS.map((id) => [id, [expected[id]]])));
      await b.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
      await sleep(1200);
      await b.evaluate('window.scrollTo(0, 0)');
      await sleep(400);
      expect(picture(await state(b)), 'nothing moved').toEqual(ref);
      expect(await b.evaluate('window.__hist'), 'and nothing counted afterwards').toEqual(hist);
    } finally {
      await b.close();
    }
  }, T_MS);

  it('scripts off: the shell and footer draw, the record stays hidden, no number is on the page and no diagram is built', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 390, height: 844 });
    try {
      await b.send('Emulation.setScriptExecutionDisabled', { value: true });
      await b.goto(page(BUYER), 500);
      const seen = await b.evaluate<{ text: string; mainHidden: boolean; leaves: number; numbered: number; built: boolean }>(`({
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim(),
        mainHidden: document.getElementById('conduct-body').hidden,
        leaves: document.querySelectorAll('#conduct-diagram .dg-leaf .n').length,
        numbered: Array.from(document.querySelectorAll('.dg-leaf .n')).filter(function (n) { return n.textContent !== '' || n.hasAttribute('data-n'); }).length,
        built: !!document.querySelector('.dg-wires')
      })`);
      expect(seen.leaves, 'the diagram and its eight leaves are in the page').toBe(8);
      expect(seen.mainHidden, 'the record is not shown without its read').toBe(true);
      expect(seen.numbered, 'no leaf holds a number it did not read').toBe(0);
      expect(seen.built).toBe(false);
      expect(seen.text).toContain('How it works');
      expect(seen.text, 'no digit anywhere a reader can see').not.toMatch(/\d/);
    } finally {
      await b.close();
    }
  }, T_MS);
});

// ------------------------------------------------------------------ (c)
// Contrast as tests/web/how-diagrams.test.ts (c) measures it: the page
// photographed as painted and again with every glyph transparent, the
// background read from the second under each text run, the ink from the
// computed colour through every ancestor's opacity, and a failure
// confirmed on the first photograph's own pixels.
function lum(c: readonly number[]): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0);
}
function ratio(a: readonly number[], b: readonly number[]): number {
  const la = lum(a); const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const needFor = (px: number, weight: number) => (px >= 23.5 || (px >= 18.5 && weight >= 700) ? 3 : 4.5);
interface Raw { data: Buffer; width: number; height: number; channels: number }
async function shot(b: RealBrowser): Promise<Raw> {
  const res = (await b.send('Page.captureScreenshot', { format: 'png' })) as { result?: { data?: string } };
  const { data, info } = await sharp(Buffer.from(res.result?.data ?? '', 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}
function pixel(img: Raw, x: number, y: number): [number, number, number] {
  const i = (Math.max(0, Math.min(img.height - 1, Math.round(y))) * img.width + Math.max(0, Math.min(img.width - 1, Math.round(x)))) * img.channels;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}
interface Run { key: string; t: string; el: string; px: number; weight: number; ink: number[]; a: number; rects: number[][] }
const RUNS = `
  (function () {
    var cv = document.createElement('canvas'); cv.width = cv.height = 1;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    function rgba(c) { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); var d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; }
    function chain(e) { var a = 1; for (; e && e.nodeType === 1; e = e.parentElement) a *= parseFloat(getComputedStyle(e).opacity); return a; }
    var vh = innerHeight, vw = document.documentElement.clientWidth, out = [], transparent = [], total = 0, i = 0;
    var w = document.createTreeWalker(document.getElementById('conduct-diagram'), NodeFilter.SHOW_TEXT);
    for (var n = w.nextNode(); n; n = w.nextNode()) {
      var key = String(i++);
      if (!/\\S/.test(n.nodeValue)) continue;
      var host = n.parentElement;
      if (!host.checkVisibility({ visibilityProperty: true })) continue;
      total++;
      var r = document.createRange(); r.selectNodeContents(n);
      var rects = Array.prototype.slice.call(r.getClientRects()).filter(function (q) { return q.width > 1 && q.height > 1; });
      var inView = rects.filter(function (q) { return q.top >= 0 && q.bottom <= vh && q.left >= 0 && q.right <= vw; });
      if (!inView.length) continue;
      var st = getComputedStyle(host), ink = rgba(st.color), a = ink[3] * chain(host);
      var t = n.nodeValue.trim().replace(/\\s+/g, ' ').slice(0, 40);
      if (a < 0.05) { transparent.push(t); continue; }
      var q0 = inView[0], hit = document.elementFromPoint(q0.left + q0.width / 2, q0.top + q0.height / 2);
      if (!(hit && (hit === host || host.contains(hit) || hit.contains(host)))) continue;
      out.push({ key: key, t: t, el: host.tagName.toLowerCase() + '.' + String(host.className).split(' ').join('.'),
        px: parseFloat(st.fontSize), weight: parseInt(st.fontWeight, 10) || 400, ink: [ink[0], ink[1], ink[2]], a: a,
        rects: inView.slice(0, 3).map(function (q) { return [q.left, q.top, q.width, q.height]; }) });
    }
    return { runs: out, transparent: transparent, total: total };
  })()
`;
const INKLESS_ON = `(function () { var s = document.createElement('style'); s.id = 'dg-inkless';
  s.textContent = '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}';
  document.head.appendChild(s); return true; })()`;
const INKLESS_OFF = `(function () { var s = document.getElementById('dg-inkless'); if (s) s.remove(); return true; })()`;

async function contrastAt(b: RealBrowser, url: string): Promise<{ measured: number; total: number; transparent: string[]; failures: string[]; midCount: string[] }> {
  await b.goto(url, 900);
  const midCount = await b.evaluate<string[]>(`Array.from(document.querySelectorAll('.dg-leaf .n')).filter(function (n) { return n.textContent !== '' && n.textContent !== n.getAttribute('data-n'); }).map(function (n) { return n.id + '=' + n.textContent; })`);
  const span = await b.evaluate<{ a: number; z: number; vh: number; vw: number }>(`(function () { var r = document.getElementById('conduct-diagram').getBoundingClientRect();
    return { a: r.top + scrollY, z: r.bottom + scrollY, vh: innerHeight, vw: document.documentElement.clientWidth }; })()`);
  const measured = new Set<string>();
  const transparent = new Set<string>();
  const failures: string[] = [];
  let total = 0;
  for (let y = Math.max(0, span.a - 120); y < span.z; y += Math.floor(span.vh * 0.6)) {
    await b.evaluate(`window.scrollTo(0, ${y})`);
    await sleep(200);
    const got = await b.evaluate<{ runs: Run[]; transparent: string[]; total: number }>(RUNS);
    total = got.total;
    got.transparent.forEach((t) => transparent.add(t));
    const runs = got.runs.filter((r) => !measured.has(r.key));
    if (runs.length === 0) continue;
    const painted = await shot(b);
    await b.evaluate(INKLESS_ON);
    await sleep(80);
    const bare = await shot(b);
    await b.evaluate(INKLESS_OFF);
    const scale = painted.width / span.vw;
    for (const run of runs) {
      measured.add(run.key);
      const ratios: number[] = [];
      const bgs: Array<[number, number, number]> = [];
      for (const [x, yy, w, h] of run.rects as Array<[number, number, number, number]>) {
        for (let i = 1; i <= 5; i += 1) {
          for (let j = 1; j <= 3; j += 1) {
            const bg = pixel(bare, (x + (w * i) / 6) * scale, (yy + (h * j) / 4) * scale);
            bgs.push(bg);
            ratios.push(ratio([0, 1, 2].map((k) => run.a * (run.ink[k] ?? 0) + (1 - run.a) * (bg[k] ?? 0)), bg));
          }
        }
      }
      ratios.sort((p, q) => p - q);
      const m = ratios[Math.floor(ratios.length * 0.25)] ?? 0;
      const need = needFor(run.px, run.weight);
      if (m >= need) continue;
      const lums = bgs.map(lum);
      const spread = Math.max(...lums) - Math.min(...lums);
      const medBg = bgs.slice().sort((p, q) => lum(p) - lum(q))[Math.floor(bgs.length / 2)] ?? [0, 0, 0];
      let best = 1;
      for (const [x, yy, w, h] of run.rects as Array<[number, number, number, number]>) {
        for (let py = Math.floor(yy * scale); py < Math.ceil((yy + h) * scale); py += 1) {
          for (let px = Math.floor(x * scale); px < Math.ceil((x + w) * scale); px += 1) {
            const r = ratio(pixel(painted, px, py), medBg);
            if (r > best) best = r;
          }
        }
      }
      if (best < need && spread <= 0.35) failures.push(`${run.el} "${run.t}" ${run.px}px/${run.weight} measured ${m.toFixed(2)} (painted ${best.toFixed(2)}) against ${need}`);
    }
  }
  return { measured: measured.size, total, transparent: [...transparent], failures, midCount };
}

describe('(c) every word in the diagram meets AA at every moment of the play', () => {
  // ?t freezes the diagram that many seconds into its play, from the
  // moment the read starts it. 0: every node waiting and no number shown.
  // 3.5: "hires started" mid count-up (its count runs 3.35 to 4.05 s) and
  // a light on the wire into "merged". 20: past the end of the play.
  const moments: Array<[string, number, number, number, boolean]> = [
    ['0', 390, 844, 21, false], ['3.5', 390, 844, 22, true], ['20', 390, 844, 29, false],
    ['0', 1280, 800, 21, false], ['3.5', 1280, 800, 22, true], ['20', 1280, 800, 29, false],
  ];
  it.each(moments)('/conduct?t=%s @ %i x %i: every text run in the diagram meets AA on painted pixels', async (t, width, height, runs, mid) => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width, height });
    try {
      const got = await contrastAt(b, page(BUYER, `&t=${t}`));
      // 21 text runs with no number showing: the title, the root's two
      // lines, two per branch head, the eight leaf labels and two per
      // plate. Replay is hidden while ?t freezes the diagram. Each number
      // shown adds one: one mid count-up at 3.5, all eight at the end.
      expect(got.total, `the diagram holds ${runs} visible text runs at ?t=${t}`).toBe(runs);
      expect(got.measured, 'the walk measured every one of them').toBe(got.total);
      if (mid) expect(got.midCount.length, 'a number is caught mid count-up').toBeGreaterThan(0);
      expect(got.transparent, 'no word is hidden outright while it waits').toEqual([]);
      expect(got.failures, 'text runs under AA against the pixels behind them').toEqual([]);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(d) the cold start: eight "0" leaves, both branches, and nothing hidden', () => {
  it('a keyed account with no history plays to eight "0" leaves in the quieter style, each laid out and visible, under both branch heads', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 390, height: 844 });
    try {
      const ref = await reference(b, COLD);
      await b.goto(page(COLD), 400);
      await toEnd(b);
      const done = await waitFinished(b, 20_000);
      expect(picture(done), 'the cold start plays to its finished picture').toEqual(ref);
      const cold = await b.evaluate<{ heads: string[]; leaves: Array<{ id: string; n: string; zero: boolean; shown: boolean; h: number; quiet: boolean }> }>(`(function () {
        function shown(e) { return e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && e.getBoundingClientRect().height > 0; }
        var quiet = getComputedStyle(document.documentElement).getPropertyValue('--fg-3').trim();
        var probe = document.createElement('span'); probe.style.color = quiet; document.body.appendChild(probe); quiet = getComputedStyle(probe).color; probe.remove();
        return {
          heads: Array.from(document.querySelectorAll('.dg-group-head')).filter(shown).map(function (h) { return h.querySelector('h3').textContent; }),
          leaves: Array.from(document.querySelectorAll('.dg-leaf')).map(function (l) { var n = l.querySelector('.n');
            return { id: n.id, n: n.textContent, zero: l.classList.contains('is-zero'), shown: shown(l) && shown(n), h: Math.round(l.getBoundingClientRect().height), quiet: getComputedStyle(n).color === quiet }; })
        };
      })()`);
      expect(cold.heads).toEqual(['When they hire', 'When their agents are hired']);
      expect(cold.leaves.map((l) => l.id)).toEqual(IDS);
      for (const l of cold.leaves) {
        expect(l, `${l.id} is a visible "0" in the quieter style`).toEqual({ id: l.id, n: '0', zero: true, shown: true, h: l.h, quiet: true });
        expect(l.h, `${l.id} keeps its full height`).toBeGreaterThanOrEqual(56);
      }
    } finally {
      await b.close();
    }
  }, T_MS);
});

// The three failed reads, planted on the page's one fetch; everything else
// still comes from the real app.
const failRead = (kind: '404' | 'network') => `(function () { var f = window.fetch; window.fetch = function (u, o) {
  if (String(u).indexOf('/buyers/') < 0) return f.call(window, u, o);
  ${kind === '404' ? "return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } }));" : "return Promise.reject(new TypeError('simulated network failure'));"}
}; })();`;

describe('(e) each failed or absent record shows today\u2019s sentence and no diagram node that carries a number', () => {
  const NONE = 'nobody-registered-this-login';
  const cases: Array<[string, string, string | null, string, string]> = [
    ['keyed: false', NONE, null, 'not-keyed-detail', `\u201c${NONE}\u201d does not resolve to an account with a verified GitHub login, so there is no conduct record to show.`],
    ['a 404', BUYER, '404', 'load-error-detail', 'There is no conduct record at that address.'],
    ['a network failure', BUYER, 'network', 'load-error-detail', 'The record could not be loaded just now. Reloading may work.'],
    ['a 503', 'conduct-diagram-503', null, 'load-error-detail', 'The record could not be loaded just now. Reloading may work.'],
  ];
  it.each(cases)('%s: the whole sentence, the record hidden, no diagram built and no leaf numbered', async (name, login, plant, sentenceId, sentence) => {
    if (skipWithoutChrome()) return;
    let failing: Server | null = null;
    let url = page(login);
    if (name === 'a 503') {
      const accounts = new MemoryAccountRepository();
      await accounts.register({ did: 'did:abt:conduct-diagram-503', githubLogin: login });
      const broken = { findByBuyerDid: () => Promise.reject(new Error('db down')) };
      failing = createApp(accounts, new MemoryAgentRepository(), undefined, undefined, broken as never).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => failing!.once('listening', resolve));
      url = `http://127.0.0.1:${(failing.address() as AddressInfo).port}/conduct?account=${login}`;
      expect((await fetch(url.replace('/conduct?account=', '/buyers/') + '/conduct')).status, 'the route really answers 503').toBe(503);
    }
    const b = await openBrowser({ width: 390, height: 844, ...(plant ? { init: failRead(plant as '404' | 'network') } : {}) });
    try {
      await b.goto(url, 900);
      const seen = await b.evaluate<{ sentence: string; bodyHidden: boolean; leaves: number; built: boolean; numbered: string[]; visibleDigits: boolean }>(`({
        sentence: document.getElementById(${JSON.stringify(sentenceId)}).textContent,
        bodyHidden: document.getElementById('conduct-body').hidden,
        leaves: document.querySelectorAll('#conduct-diagram .dg-leaf .n').length,
        built: !!document.querySelector('.dg-wires'),
        numbered: Array.from(document.querySelectorAll('.dg-leaf .n')).filter(function (n) { return n.textContent !== '' || n.hasAttribute('data-n'); }).map(function (n) { return n.id; }),
        visibleDigits: /\\d/.test(Array.from(document.querySelectorAll('#conduct-diagram *')).filter(function (e) { return e.checkVisibility(); }).map(function (e) { return e.textContent; }).join(''))
      })`);
      // leaves: the eight leaves are in the page, so "none numbered" is
      // about them and not about an empty set.
      expect(seen).toEqual({ sentence, bodyHidden: true, leaves: 8, built: false, numbered: [], visibleDigits: false });
    } finally {
      await b.close();
      if (failing) await new Promise<void>((resolve) => failing!.close(() => resolve()));
    }
  }, T_MS);
});

// main's words, exactly as the page read before the diagram.
const MEANS = [
  'hires started|Agreements both sides signed and a deposit was paid on.',
  'merged|Paid in full, then merged the pull request into their own repository.',
  'completed without a decision|Paid in full, then neither merged nor closed inside seven days.',
  'closed with a reason|Paid in full, then closed the pull request naming a line it missed.',
  'redos requested|Sent work back once, citing a line, before paying the balance.',
  'walked away|Work was delivered and they declined it, or went quiet for seven days.',
  'delivered and never paid for|Work was staged and the buyer declined it or went quiet. Counted here because it happened, not because anyone was at fault.',
  'redos refused|A buyer sent work back citing a line and the operator declined to redo it.',
];
const PARAS = [
  'Six counts. Every hire this account has paid a deposit on.',
  'Nothing here is added up and nothing here is a rate. Fourteen hires with one walk-away is a different thing from two hires with one walk-away, and a percentage would hide which of those you are looking at.',
  'Two counts. These are about how this account behaved as the party doing the work, and they are kept separate from what their agents delivered.',
  'What their agents actually delivered lives on each agent\u2019s own profile, in three unblended tiers. It is deliberately not repeated here: this page is about conduct, and that page is about evidence.',
];
const ITEMS = [
  'These are counts, never a score|no rating exists|No star, no percentage, no letter, no computed reliability, and no total. Eight numbers stay eight numbers. Deciding what they mean is yours.',
  'Tied to a confirmed GitHub account|not to a wallet|A fresh identity is free to make, so a record attached to one would be worth nothing. This is attached to the same GitHub account that lists the repositories a person can hire against.',
  'A zero is shown as a zero|always|An account with no history shows the same eight rows, all at zero. There is no new badge and nothing is hidden to make an empty record look fuller.',
  'Nothing here says anyone was wrong|no fault is recorded|Declining delivered work is allowed. Refusing a redo is allowed. Both are counted because they happened and because the other side is entitled to know, not because FreeAgents thinks either was a mistake.',
  'Operators can require a record before they take work|their choice|An operator can set their agents to only accept buyers above a certain number of merges, or below a certain number of walk-aways. FreeAgents does not set those numbers and does not recommend any.',
];
const VIEW = `(function () {
  function shown(e) { return e.checkVisibility({ visibilityProperty: true }) && e.getBoundingClientRect().height > 0; }
  function txt(e) { return e.textContent.replace(/\\s+/g, ' ').trim().replace(/'/g, '\\u2019'); }
  return {
    buttons: Array.from(document.querySelectorAll('main button[data-disclose]')).map(function (b) { return [b.textContent.trim(), b.getAttribute('aria-expanded'), document.getElementById(b.getAttribute('data-disclose')).hidden]; }),
    means: Array.from(document.querySelectorAll('.dg-def dt')).filter(shown).map(function (d) { return txt(d) + '|' + txt(d.nextElementSibling); }),
    paras: Array.from(document.querySelectorAll('#count-means > p')).filter(shown).map(txt),
    items: Array.from(document.querySelectorAll('.fixed li')).filter(shown).map(function (li) { return Array.from(li.children).map(txt).join('|'); }),
    stored: localStorage.length + sessionStorage.length
  };
})()`;

describe('(f) the definitions, both paragraphs and the five items sit behind two disclosures, closed on every visit', () => {
  it('both closed at load; "Show what each count means" opens to main\u2019s eight definitions and four lines; "Show how to read this" opens to main\u2019s five items; both closed again on reload', async () => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width: 1280, height: 800 });
    try {
      await b.goto(page(BUYER), 700);
      const closed = await b.evaluate<Record<string, unknown>>(VIEW);
      expect(closed).toEqual({ buttons: [['Show what each count means', 'false', true], ['Show how to read this', 'false', true]], means: [], paras: [], items: [], stored: 0 });
      await clickCentre(b, "document.querySelector('[data-disclose=\"count-means\"]')");
      await sleep(400);
      expect(await b.evaluate(VIEW)).toEqual({ buttons: [['Hide what each count means', 'true', false], ['Show how to read this', 'false', true]], means: MEANS, paras: PARAS, items: [], stored: 0 });
      await clickCentre(b, "document.querySelector('[data-disclose=\"how-to-read\"]')");
      await sleep(600);
      expect(await b.evaluate(VIEW)).toEqual({ buttons: [['Hide what each count means', 'true', false], ['Hide how to read this', 'true', false]], means: MEANS, paras: PARAS, items: ITEMS, stored: 0 });
      await b.goto(page(BUYER), 700);
      expect(await b.evaluate(VIEW), 'both closed again on reload').toEqual(closed);
    } finally {
      await b.close();
    }
  }, T_MS);
});

describe('(g) no sample number ships: the page and every script it loads carry none', () => {
  it('the served page\u2019s eight leaves ship with no number, no data-n and no zero style; nothing it loads handles a demo parameter, says "Sample numbers" or names an account', async () => {
    const res = await fetch(page(BUYER), { headers: { Accept: 'text/html' } });
    const html = await res.text();
    const leaves = [...html.matchAll(/<div class="dg-node dg-leaf[^"]*"[^>]*>\s*<span([^>]*)>([^<]*)<\/span>/g)];
    expect(leaves.map((m) => /id="([^"]+)"/.exec(m[1] ?? '')?.[1]), 'the eight leaves, in page order').toEqual(IDS);
    for (const m of leaves) {
      expect(m[2], 'a leaf ships with no number').toBe('');
      expect(m[1], 'or a value to count to').not.toMatch(/data-n=/);
      expect(m[0], 'or the zero style').not.toMatch(/is-zero/);
    }
    const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(srcs.length).toBeGreaterThan(5);
    const bodies = [html, ...(await Promise.all(srcs.map(async (s) => (await fetch(`${baseUrl}${s}`)).text())))];
    const names = ['the page', ...srcs];
    bodies.forEach((text, i) => {
      expect(text, `${names[i]} handles a demo parameter`).not.toMatch(/(get|has)\(\s*["']demo["']\s*\)|[?&]demo\b/);
      expect(text, `${names[i]} says "Sample numbers"`).not.toMatch(/sample numbers/i);
      // The prototype fell back to a hard-coded account when the address
      // named none, and showed a made-up one in demo mode. Neither ships:
      // no script defaults the account to any literal, and no sample
      // account name appears.
      expect(text, `${names[i]} falls back to a hard-coded account`).not.toMatch(/get\(\s*["']account["']\s*\)\s*\|\|\s*["'][^"']/);
      expect(text, `${names[i]} names an example account`).not.toMatch(/example-account|northline/i);
    });
    const conduct = bodies[srcs.indexOf('/js/pages/conduct.js') + 1] ?? '';
    expect(conduct, 'the account comes from the address alone').toContain('.get("account") || ""');
    const counts = [...conduct.matchAll(/setCount\("([^"]+)", ([^)]+)\)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(counts, 'each count is written from its response field and nothing else').toEqual(FIELDS.map(([id, side, field]) => `${id} ${side}.${field}`));
  });
});

describe('(h) on a touch phone and a touch desktop: no sideways scroll, 44 px controls, branches side by side on a computer and stacked on a phone', () => {
  it.each([[320, 640], [390, 844], [1280, 800]])('@ %i: after the play, nothing past either edge, every control clears 44 px, the branches take the right form', async (width, height) => {
    if (skipWithoutChrome()) return;
    const b = await openBrowser({ width, height, touch: true });
    try {
      await b.goto(page(BUYER), 600);
      await toEnd(b);
      expect((await waitFinished(b, 25_000)).replayShown, 'finished').toBe(true);
      await b.evaluate('window.scrollTo(0, 0)');
      await sleep(300);
      const out = await b.evaluate<{ coarse: boolean; W: number; sw: number; past: string[]; controls: Array<{ what: string; w: number; h: number }>; g1: number[]; g2: number[]; lastBuyer: number; plates: number[] }>(`(function () {
        var W = document.documentElement.clientWidth, past = [];
        Array.from(document.querySelectorAll('main *')).forEach(function (e) { var r = e.getBoundingClientRect(); if (!r.width && !r.height) return;
          if (r.right > W + 0.5 || r.left < -0.5) past.push(e.tagName + '.' + e.getAttribute('class') + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); });
        function box(e) { var r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.right)]; }
        var heads = document.querySelectorAll('.dg-group-head'), leaves = document.querySelectorAll('#buyer-counts .dg-leaf');
        return { coarse: matchMedia('(pointer: coarse)').matches, W: W, sw: document.documentElement.scrollWidth, past: past,
          controls: Array.from(document.querySelectorAll('.dg-replay, main button[data-disclose]')).map(function (e) { var r = e.getBoundingClientRect(); return { what: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) }; }),
          g1: box(heads[0]), g2: box(heads[1]), lastBuyer: Math.round(leaves[leaves.length - 1].getBoundingClientRect().bottom + scrollY),
          plates: Array.from(document.querySelectorAll('.dg-nope')).map(function (p) { return Math.round(p.getBoundingClientRect().top + scrollY); }) };
      })()`);
      expect(out.coarse).toBe(true);
      expect(out.sw, 'no sideways scroll').toBe(out.W);
      expect(out.past, 'nothing past either edge').toEqual([]);
      expect(out.controls.map((c) => c.what)).toEqual(['Replay', 'Show what each count means', 'Show how to read this']);
      for (const c of out.controls) {
        expect(c.h, `${c.what} height`).toBeGreaterThanOrEqual(44);
        expect(c.w, `${c.what} width`).toBeGreaterThanOrEqual(44);
      }
      if (width > 900) {
        expect(out.g2[1], 'the two branch heads sit on one line').toBe(out.g1[1]);
        expect(out.g2[0], 'side by side').toBeGreaterThan(out.g1[2]!);
        expect(new Set(out.plates).size, 'the three plates share a row').toBe(1);
      } else {
        expect(out.g2[0], 'the branches share one column').toBe(out.g1[0]);
        expect(out.g2[1], 'the second branch starts below the first branch\u2019s last leaf').toBeGreaterThan(out.lastBuyer);
        expect(new Set(out.plates).size, 'one plate a row').toBe(3);
      }
    } finally {
      await b.close();
    }
  }, T_MS);
});
