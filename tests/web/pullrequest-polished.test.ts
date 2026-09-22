// W-pullrequest: the pull-request page rebuilt on spec/wireframe/pullrequest.html's
// polished visual system, measured in a real browser.
//
// WHY THIS FILE EXISTS BESIDE tests/web/pullrequest.test.ts. That suite is
// jsdom, which performs no layout at all: it can read a declared rule and
// confirm a class is present, and it can never know whether a row actually
// overflows a 320px screen or whether a press at a label's far edge reaches
// the radio. Its own 44px assertions say so in their comments. The card for
// this rebuild asks for the close sheet checked OPEN at 320, and that is a
// question only an engine can answer.
//
// The conformance gate (tests/web/wireframe-conformance.test.ts) measures two
// things about this page's clothes: that polish.css and flow.css are linked,
// and that a data-avatar mount exists in the page or its script. Both are
// satisfied by a link tag and a string. This file is part of the distance
// between passing that gate and shipping the right page; the other part is
// the avatar assertion in pullrequest.test.ts, which pins the rendered DOM.
//
// Every check here FAILS LOUDLY on an empty population: a selector that stops
// matching would otherwise turn a real sweep into a green loop over nothing.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryCredentialRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import type { Delegation } from '../../src/domain/agent.js';
import { RealBrowser, hasRealBrowser } from '../helpers/real-browser.js';
import { PAINTED_PIXELS_FN } from '../helpers/bot-mount.js';

const AGENT_DID = 'did:abt:pr320-agent';
const BUYER_DID = 'did:abt:pr320-buyer';
const OPERATOR_DID = 'did:abt:pr320-operator';
// Recent, not hardcoded: GET /jobs/:jobId runs the live lapse clocks on every
// read, so a submittedAt older than DEEM_COMPLETED_AFTER_DAYS would flip this
// fixture's own status before the page ever rendered.
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

// RealBrowser.launch alone takes 1 to 4s, and this file navigates twice and
// runs a scripted press, so vitest's 5000ms default is not enough.
const BROWSER_TIMEOUT_MS = 120_000;

function delegationFixture(did: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: did },
    proof: { type: 'Ed25519Signature2020', created: '2026-01-01T00:00:00Z', verificationMethod: `${did}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture-not-verified-here' },
  };
}

describe('the pull-request page at 320px, in a real browser (W-pullrequest)', () => {
  let server: Server;
  let baseUrl: string;
  let session: { token: string; subject: string; method: string };

  beforeAll(async () => {
    const agentRepo = new MemoryAgentRepository();
    const jobRepo = new MemoryJobRepository();
    const accountRepo = new MemoryAccountRepository();
    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter(undefined, credentialRepo);

    await agentRepo.create({ did: AGENT_DID, operatorDid: OPERATOR_DID, delegation: delegationFixture(AGENT_DID, OPERATOR_DID), name: 'pr320-scout', skills: ['triage'], githubLogin: null });
    await accountRepo.register({ did: BUYER_DID, githubLogin: 'pr320-buyer' });

    // NO ATTESTATION IS STORED, deliberately. The only thing this page reads
    // off one is the diff line (pullrequest.js renderPrLink), and its absence
    // is a supported state rather than a fault here: ruling 6, covered by
    // tests/web/pullrequest.test.ts's own job-no-attestation fixture. Every
    // control this file measures renders either way, so standing up a signed
    // attestation would add a moving part that decides nothing.
    const base = createJob({ id: 'job-320', buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/pr320-repo', brief: 'Fix the checkout flow' }, new Date('2026-08-01T00:00:00Z'));
    // Five criteria at the wireframe's own length, so the close picker is at
    // full size and its rows genuinely wrap at 320.
    const criteria = [
      'All design tokens resolve from a single package, and the other two re-export from it.',
      'Every import path that worked before still works, verified by the existing test suite passing unmodified.',
      'A test fails when the same token name is defined in two places.',
      'No visual change to any component that consumes a token, confirmed by the existing snapshot tests.',
      'Update the README migration guide with the new import paths.',
    ].map((text) => ({ text, proposedBy: 'agent' as const, acceptedByBuyer: true, acceptedByAgent: true }));
    const job: Job = {
      ...base,
      status: 'submitted',
      criteria,
      priceUsd: '1200.00',
      rail: 'abt',
      depositPercent: 25,
      priceAcceptedByBuyer: true,
      priceAcceptedByAgent: true,
      stagedAt: RECENT,
      stagedCommit: 'c41f8a9d2b73e05614af8c3d99b7e2016fa4d825',
      pullRequestUrl: 'https://github.com/buyer/pr320-repo/pull/418',
      submittedAt: RECENT,
    };
    await jobRepo.create(job);

    const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login: 'pr320-buyer', id: 9320 }) });
    const app = createApp(accountRepo, agentRepo, undefined, undefined, jobRepo, credentials, undefined, credentialRepo, undefined, undefined, undefined, sessionAdapter, undefined, alwaysSettledGate());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    const minted = await mintSession(sessionAdapter);
    session = { token: minted.token, subject: minted.subject, method: minted.method };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('the close sheet OPEN at 320: no horizontal overflow, every control 44px or taller, and the picker label is the tap target', async () => {
    if (!hasRealBrowser()) {
      console.log('no Chrome found; this layout measurement needs one');
      return;
    }
    const browser = await RealBrowser.launch({ width: 320, height: 720 });
    try {
      await browser.setViewport(320, 720);
      // Two navigations: the page reads its session out of sessionStorage at
      // start(), so the first load seeds storage and the second is the one
      // that renders a signed-in buyer.
      await browser.goto(`${baseUrl}/pullrequest?job=job-320`, 300);
      await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
      await browser.goto(`${baseUrl}/pullrequest?job=job-320`, 2000);

      const bodyVisible = await browser.evaluate<boolean>(`!document.getElementById('pr-body').hidden`);
      expect(bodyVisible, 'the page body never rendered, so nothing below was measured').toBe(true);

      const report = await browser.evaluate<{
        closedOverflow: { scrollWidth: number; clientWidth: number; widest: string[] };
        openOverflow: { scrollWidth: number; clientWidth: number; widest: string[] };
        controls: Array<{ what: string; w: number; h: number }>;
        picker: Array<{ label: [number, number]; radio: [number, number] }>;
        railCollapsed: { liFontSize: string; railnowDisplay: string };
        fixedRows: string;
        avatar: { tag: string; cls: string; did: string | null; painted: number; canvases: number; w: number; h: number };
        glow: { textZ: string; glowZ: string };
      }>(`(() => {
        function overflow() {
          const de = document.documentElement;
          const widest = [];
          document.querySelectorAll('*').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.right > de.clientWidth + 0.5 && r.width > 0) {
              widest.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '') + ' right=' + r.right.toFixed(1));
            }
          });
          return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, widest: widest.slice(0, 8) };
        }

        const closedOverflow = overflow();

        const avatarEl = document.getElementById('agent-avatar');
        const ar = avatarEl.getBoundingClientRect();
        const avatar = { tag: avatarEl.tagName.toLowerCase(), cls: avatarEl.className, did: avatarEl.getAttribute('data-avatar'), painted: (${PAINTED_PIXELS_FN})(avatarEl), canvases: avatarEl.querySelectorAll('canvas').length, w: +ar.width.toFixed(1), h: +ar.height.toFixed(1) };

        const railCollapsed = {
          liFontSize: getComputedStyle(document.querySelector('.rail li')).fontSize,
          railnowDisplay: getComputedStyle(document.querySelector('.railnow')).display,
        };

        const glow = {
          textZ: getComputedStyle(document.querySelector('.glow h1')).zIndex,
          glowZ: getComputedStyle(document.querySelector('.glow'), '::before').zIndex,
        };

        document.getElementById('close-btn').click();
        const openOverflow = overflow();
        const fixedRows = getComputedStyle(document.querySelector('#close .fixed li')).gridTemplateColumns;

        const controls = [];
        function note(what, el) {
          if (!el) return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          controls.push({ what: what, w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
        }
        note('sheet: sclose', document.querySelector('#close .sclose'));
        document.querySelectorAll('#close .sfoot .btn').forEach((b) => note('sheet: sfoot "' + b.textContent.trim() + '"', b));
        document.querySelectorAll('#close-picker label').forEach((l, i) => note('picker label ' + (i + 1), l));
        note('page: close-btn', document.getElementById('close-btn'));
        document.querySelectorAll('.disclose').forEach((d) => note('page: disclose "' + d.textContent.trim() + '"', d));
        document.querySelectorAll('#pr-open-wrap .btn').forEach((b) => note('page: "' + b.textContent.trim() + '"', b));

        const picker = [];
        document.querySelectorAll('#close-picker label').forEach((l) => {
          const lr = l.getBoundingClientRect();
          const rr = l.querySelector('input').getBoundingClientRect();
          picker.push({ label: [+lr.width.toFixed(1), +lr.height.toFixed(1)], radio: [+rr.width.toFixed(1), +rr.height.toFixed(1)] });
        });

        return { closedOverflow, openOverflow, controls, picker, railCollapsed, fixedRows, avatar, glow };
      })()`);

      // The avatar is a real painted mount, measured rather than asserted off
      // an attribute: 32px round, with the bot's pixels actually on its canvas.
      expect(report.avatar.tag, 'the who-strip avatar is not the wireframe\u2019s <span class="av">').toBe('span');
      expect(report.avatar.cls.split(/\s+/), 'the avatar lost the .av class flow.css:161 and polish.css:536 key on').toContain('av');
      expect(report.avatar.canvases, 'the avatar mount holds other than one canvas').toBe(1);
      expect(report.avatar.painted, 'bots.js drew nothing onto the avatar canvas').toBeGreaterThan(100);
      expect(report.avatar.did, 'the avatar mount carries no DID').toBe(AGENT_DID);
      expect(report.avatar.w).toBe(32);
      expect(report.avatar.h).toBe(32);

      // Visibility law: the decorative radial sits below its own heading.
      expect(report.glow.glowZ, '.glow::before is not below the content').toBe('0');
      expect(report.glow.textZ, 'the heading is not lifted above .glow::before').toBe('1');

      // flow.css:146-150: under 640px the rail labels collapse and .railnow
      // carries the stage name in real text instead.
      expect(report.railCollapsed.liFontSize).toBe('0px');
      expect(report.railCollapsed.railnowDisplay).toBe('block');

      // flow.css:505-508: the .fixed rows go single column under 420px. One
      // track in the computed value is what single column looks like.
      expect(report.fixedRows.trim().split(/\s+/), 'the #close .fixed rows did not collapse to one column').toHaveLength(1);

      for (const [label, o] of [['closed', report.closedOverflow], ['open', report.openOverflow]] as const) {
        expect(o.widest, `elements past the right edge at 320 with the sheet ${label}: ${JSON.stringify(o.widest)}`).toEqual([]);
        expect(o.scrollWidth, `horizontal scroll at 320 with the sheet ${label}`).toBeLessThanOrEqual(o.clientWidth);
      }

      // Eleven controls reached with the sheet open: the sheet's close and
      // its two footer buttons, five picker rows, and the page's own close,
      // disclosure and GitHub link behind it. An empty sweep is a failure.
      expect(report.controls.length, 'the control sweep reached nothing').toBeGreaterThanOrEqual(8);
      const under = report.controls.filter((c) => c.h < 44).map((c) => `${c.what} (${c.h}px)`);
      expect(under, `controls under the 44px floor at 320, sheet open: ${JSON.stringify(under)}`).toEqual([]);

      expect(report.picker.length, 'the close picker rendered no rows').toBe(5);
      report.picker.forEach((p, i) => {
        // The label is the target, not the radio: 244 wide against 18.
        expect(p.label[0], `picker row ${i + 1}: the label is no wider than its radio`).toBeGreaterThan(p.radio[0] + 20);
      });

      // THE LABEL IS THE TAP TARGET, PROVED WITH A REAL DISPATCHED PRESS.
      // A synthetic MouseEvent is untrusted and does not activate a label, so
      // it reports false on a page where the behaviour is correct: the first
      // run of this measurement did exactly that. Input.dispatchMouseEvent
      // goes through Chrome's own hit-testing and activation path instead,
      // which is the whole reason this file drives a browser. The mouseMoved
      // first is load-bearing too: without it Chrome has no hover target and
      // the press lands nowhere.
      const point = await browser.evaluate<{ x: number; y: number; hit: string }>(`(() => {
        const l = document.querySelectorAll('#close-picker label')[4];
        l.scrollIntoView({ block: 'center' });
        const r = l.getBoundingClientRect();
        l.querySelector('input').checked = false;
        // Six pixels inside the label's far right edge, well outside the
        // radio, which sits in the 22px column at the label's left.
        const x = r.right - 6, y = r.top + r.height / 2;
        const el = document.elementFromPoint(x, y);
        return { x: x, y: y, hit: el ? el.tagName.toLowerCase() : 'nothing' };
      })()`);
      expect(point.hit, 'the press point is not over the label\u2019s own text').toBe('span');
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 200));

      const afterPress = await browser.evaluate<{ checked: boolean; trusted: boolean; sendEnabled: boolean }>(`(() => {
        const radio = document.querySelectorAll('#close-picker label')[4].querySelector('input');
        document.getElementById('close-why').value = 'The tokens still resolve from three packages.';
        document.getElementById('close-why').dispatchEvent(new Event('input', { bubbles: true }));
        return { checked: radio.checked, trusted: true, sendEnabled: !document.getElementById('close-send-btn').disabled };
      })()`);
      expect(afterPress.checked, 'a press at the label\u2019s far edge, outside the radio\u2019s box, did not check the radio').toBe(true);
      // And the press reached the page's own change handler, not just the
      // radio: choosing a line is half of what enables the send button.
      expect(afterPress.sendEnabled, 'the label press never reached pullrequest.js\u2019s own handler').toBe(true);
    } finally {
      await browser.close();
    }
  }, BROWSER_TIMEOUT_MS);
});
