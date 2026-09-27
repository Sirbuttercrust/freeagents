// Two rules from the AV2 brief, checked on the rendered pages rather than
// read off the source:
//
//   1. Wherever an avatar renders, the agent's name renders beside it: in the
//      same card or row, which here means within three ancestors of the
//      avatar host. A face with no name beside it is an identity claim the
//      reader cannot tie to anyone.
//   2. The avatar editor appears only to the agent's operator. The editor
//      lives on My agents alone, and even there it is built only when the
//      agent read names the signed-in account as operator.
//
// jsdom, so no pixels: the pixels are asserted in real Chrome elsewhere
// (myagents-polished, landing-bots, pullrequest-polished).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JSDOM, VirtualConsole } from 'jsdom';
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

const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const AGENTS = [
  { did: 'did:abt:zNameBesideAlpha', name: 'alpha-scout' },
  { did: 'did:abt:zNameBesideBravo', name: 'bravo-builder' },
];

let server: Server;
let baseUrl: string;
let session: Session;
let operatorDid: string;

function delegationFixture(did: string, op: string): Delegation {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: op,
    credentialSubject: { id: did, operator: op },
    proof: { type: 'Ed25519Signature2020', proofValue: 'fixture' },
  } as unknown as Delegation;
}

beforeAll(async () => {
  process.env.FREEAGENTS_PLATFORM_SEED ??= 'e'.repeat(64);
  const agentRepo = new MemoryAgentRepository();
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: fakeGitHubFetch({ login: 'name-beside-operator', id: 8801 }),
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
  for (const a of AGENTS) {
    await agentRepo.create({
      did: a.did, operatorDid, delegation: delegationFixture(a.did, operatorDid),
      name: a.name, skills: ['triage'], githubLogin: null,
    });
  }
  // One override, so a page that draws only DID defaults is not what passes.
  await agentRepo.setAvatarSpec(AGENTS[1]!.did, { shape: 'mech', face: 'mouth', colour: 'c9' });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Opts {
  signedIn?: boolean;
  // Replaces the JSON body of GET <path> (the path exactly as the page asks
  // for it) before the page sees it. Every other request passes untouched.
  rewrite?: { path: string; edit: (body: Record<string, unknown>) => Record<string, unknown> };
}

async function render(path: string, ready: (doc: Document) => boolean, opts: Opts = {}): Promise<{ doc: Document; close(): void }> {
  const vc = new VirtualConsole();
  const failures: string[] = [];
  vc.on('jsdomError', (e: Error) => failures.push(e.message));
  const markup = await (await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } })).text();
  // FIX-CIFLAKE cause 1b: every fetch the page fires goes through here, so
  // the count still in flight is a settle signal that holds regardless of
  // which page or how many per-row reads it makes (tests/web/operator-
  // roster.test.ts's render() reads the identical signal the same way).
  let inFlight = 0;
  const dom = new JSDOM(markup, {
    url: `${baseUrl}${path}`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      if (opts.signedIn) window.sessionStorage.setItem('fa_session', JSON.stringify(session));
      Object.defineProperty(window, 'fetch', {
        writable: true,
        value: async (input: string, init?: RequestInit) => {
          inFlight += 1;
          try {
            const url = new URL(input, baseUrl);
            const res = await fetch(url, init);
            const rw = opts.rewrite;
            if (!rw || (init?.method ?? 'GET') !== 'GET' || url.pathname !== rw.path) return res;
            const body = (await res.json()) as Record<string, unknown>;
            return new Response(JSON.stringify(rw.edit(body)), {
              status: res.status,
              headers: { 'Content-Type': 'application/json' },
            });
          } finally {
            inFlight -= 1;
          }
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !ready(dom.window.document)) await new Promise((r) => setTimeout(r, 50));
  // FIX-CIFLAKE cause 1b: `ready` (mountedAll, editorReady) can read true
  // straight after pcard.js's SYNCHRONOUS mount, before the per-card GET
  // /agents/:did avatar read this page also fires has answered
  // (tests/web/avatar-identity.test.ts's own DOM signal cannot tell a
  // first mount from the avatar-read mount, the identical gap
  // operator-roster.test.ts's browseSettled comment documents). Waiting
  // for three quiet polls in a row -- none in flight -- closes that
  // window: a read that answers after this point can still land on a
  // torn-down document if the caller closes without heeding it, which is
  // exactly what Make 1a's page-side isConnected guards are for.
  let quiet = 0;
  const quietDeadline = Date.now() + 4000;
  while (quiet < 3 && Date.now() < quietDeadline) {
    await new Promise((r) => setTimeout(r, 20));
    quiet = inFlight === 0 ? quiet + 1 : 0;
  }
  if (quiet < 3) throw new Error(`${path}: still had ${inFlight} read(s) in flight after 4000ms`);
  if (failures.length > 0) throw new Error(`page script failed: ${failures.join('; ')}`);
  return { doc: dom.window.document, close: () => dom.window.close() };
}

// For each avatar host, how many ancestors up the agent's name first appears.
function nameDistance(doc: Document): Array<{ did: string; name: string; hops: number | null }> {
  return Array.from(doc.querySelectorAll('[data-avatar]')).map((host) => {
    const did = host.getAttribute('data-avatar') ?? '';
    const name = AGENTS.find((a) => a.did === did)?.name ?? '';
    let el: Element | null = host;
    for (let hops = 0; el && hops <= 6; hops += 1, el = el.parentElement) {
      if (name && (el.textContent ?? '').includes(name)) return { did, name, hops };
    }
    return { did, name, hops: null };
  });
}

const mountedAll = (n: number) => (doc: Document) =>
  doc.querySelectorAll('[data-avatar-shape]').length >= n;

describe('every rendered agent avatar has the agent\u2019s name in the same card or row', () => {
  const pages: Array<[string, () => string, number, boolean]> = [
    ['browse', () => '/browse', 2, false],
    ['agent profile', () => `/agents/${encodeURIComponent(AGENTS[1]!.did)}`, 1, false],
    ['operator page roster', () => `/accounts/${encodeURIComponent(operatorDid)}`, 2, false],
    ['hire', () => `/hire?agent=${encodeURIComponent(AGENTS[0]!.did)}`, 1, true],
    ['my agents', () => '/myagents', 2, true],
  ];
  for (const [label, path, n, signedIn] of pages) {
    it(label, async () => {
      const page = await render(path(), mountedAll(n), { signedIn });
      try {
        // The operator's own mark is a person, not an agent; it is named by
        // the operator header, not by an agent name.
        const found = nameDistance(page.doc).filter((r) => r.did !== operatorDid);
        expect(found.length, `${label}: fewer agent avatars than the fixture has`).toBeGreaterThanOrEqual(n);
        for (const r of found) {
          expect(r.name, `${label}: an avatar for a DID the fixture does not know (${r.did})`).not.toBe('');
          expect(r.hops, `${label}: ${r.name}'s avatar has no name within three ancestors`).not.toBeNull();
          expect(r.hops!, `${label}: ${r.name}'s name is ${r.hops} ancestors from its avatar`).toBeLessThanOrEqual(3);
        }
      } finally {
        page.close();
      }
    });
  }
});

describe('only the agent\u2019s operator gets the avatar editor', () => {
  const editorReady = (doc: Document) => doc.querySelectorAll('.arow [data-avatar-shape]').length >= 2;

  it('control: on My agents the operator gets one editor per own agent', async () => {
    const page = await render('/myagents', editorReady, { signedIn: true });
    try {
      // Wait for the editors, which are built after each detail read.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && page.doc.querySelectorAll('.avedit-toggle').length < 2) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(page.doc.querySelectorAll('.avedit-toggle').length).toBe(2);
      expect(page.doc.querySelectorAll('.avedit').length).toBe(2);
    } finally {
      page.close();
    }
  });

  it('a row whose agent read names a different operator gets no editor', async () => {
    // The roster is the signed-in account's own, so this can only arise from
    // a stale or inconsistent read. The page must still refuse: the editor
    // is built from the agent read's operatorDid, never from the roster.
    const page = await render('/myagents', editorReady, {
      signedIn: true,
      rewrite: {
        path: `/agents/${encodeURIComponent(AGENTS[0]!.did)}`,
        edit: (body) => ({ ...body, operatorDid: 'did:abt:zSomeoneElse' }),
      },
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
      const rowOf = (did: string) => page.doc.querySelector(`.rav[data-avatar="${did}"]`)?.closest('.arow');
      // Booleans, not elements: vitest cannot print a jsdom node in a
      // failure message and would report a TypeError instead of the reason.
      expect(!!rowOf(AGENTS[0]!.did), 'the rewritten row did not render').toBe(true);
      expect(!!rowOf(AGENTS[0]!.did)?.querySelector('.avedit, .avedit-toggle'), 'an editor for an agent this account does not operate').toBe(false);
      expect(!!rowOf(AGENTS[1]!.did)?.querySelector('.avedit-toggle'), 'the control row lost its editor too').toBe(true);
    } finally {
      page.close();
    }
  });

  it.each([
    ['browse', '/browse'],
    ['the agent profile, even for its operator', `/agents/${encodeURIComponent(AGENTS[0]!.did)}`],
    ['the operator page', '/accounts/'],
  ])('%s carries no editor', async (_label, path) => {
    const full = path === '/accounts/' ? `/accounts/${encodeURIComponent(operatorDid)}` : path;
    const page = await render(full, mountedAll(1), { signedIn: true });
    try {
      expect(page.doc.querySelectorAll('[data-avatar-shape]').length, 'nothing mounted, so the check means nothing').toBeGreaterThan(0);
      expect(page.doc.querySelectorAll('.avedit, .avedit-toggle, input[name$="-shape"]').length).toBe(0);
    } finally {
      page.close();
    }
  });
});

// FIX-CIFLAKE cause 1c: a late per-row avatar read that answers after the
// window that fired it has closed. Reproduces the exact shape 8 CI runs
// showed (bots.js's mount() running document.createElement on a window
// jsdom has already torn down, TypeError: Cannot read properties of
// undefined (reading 'createElement')): a fetch stub delays GET
// /agents/:did well past load, the caller closes the window at once
// (never waiting for that read, unlike render() above), and the test
// then waits past the delay and checks nothing blew up. Must pass on the
// Make 1a page guards and go red with them reverted -- proven below by
// running it against the pre-fix tree (git stash) and observing the
// unhandled rejection this same probe catches.
describe('a late per-row avatar read never writes into a page whose window already closed (FIX-CIFLAKE cause 1c)', () => {
  async function renderThenCloseBeforeReadSettles(
    path: string,
    delayMs: number,
    paintedSignal: (doc: Document) => boolean,
  ): Promise<{ jsdomErrors: string[]; unhandled: unknown[] }> {
    const vc = new VirtualConsole();
    const jsdomErrors: string[] = [];
    vc.on('jsdomError', (e: Error) => jsdomErrors.push(e.message));
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const markup = await (await fetch(`${baseUrl}${path}`, { headers: { Accept: HTML } })).text();
      const dom = new JSDOM(markup, {
        url: `${baseUrl}${path}`,
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole: vc,
        beforeParse(window) {
          Object.defineProperty(window, 'fetch', {
            writable: true,
            value: async (input: string, init?: RequestInit) => {
              const url = new URL(input, baseUrl);
              // The one read this probe delays: every per-row/per-card
              // avatar detail read (GET /agents/:did), on both browse.js
              // and operator.js's roster. Every other request (the
              // /browse or /accounts/:did listing itself, static assets)
              // passes straight through, so the page reaches its normal
              // first paint before this probe closes it. url.pathname
              // keeps a DID's own colons percent-encoded (%3A), so the
              // match is against the RAW input path browse.js/operator.js
              // actually fetch, not the parsed and re-encoded pathname.
              if (String(input).startsWith('/agents/')) {
                await new Promise((r) => setTimeout(r, delayMs));
              }
              return fetch(url, init);
            },
          });
        },
      });
      await new Promise<void>((resolve) => {
        if (dom.window.document.readyState === 'complete') resolve();
        else dom.window.addEventListener('load', () => resolve());
      });
      // First paint: the cards/rows are in the DOM (pcard.js's own
      // SYNCHRONOUS mount, before the per-row avatar detail read this
      // probe delays has gone out) -- the same point
      // tests/web/avatar-identity.test.ts's mountedAll signal reads,
      // reached here without waiting for the delayed read itself.
      const paintDeadline = Date.now() + 5000;
      while (Date.now() < paintDeadline && !paintedSignal(dom.window.document)) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // Closes right after first paint, deliberately NOT waiting for the
      // delayed per-row avatar read: this is the exact race the brief
      // names, a read that answers after the caller has already moved on.
      dom.window.close();
      await new Promise((r) => setTimeout(r, delayMs + 300));
      return { jsdomErrors, unhandled };
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  }

  it('browse: a delayed per-card avatar read after close raises no unhandled rejection', async () => {
    const { jsdomErrors, unhandled } = await renderThenCloseBeforeReadSettles('/browse', 300, mountedAll(2));
    expect(jsdomErrors, `jsdom errors: ${jsdomErrors.join('; ')}`).toEqual([]);
    expect(unhandled.map(String), 'a late read wrote into a closed page').toEqual([]);
  });

  it('the operator roster: a delayed per-row avatar read after close raises no unhandled rejection', async () => {
    const rosterPainted = (doc: Document) => doc.querySelectorAll('[data-agent-row]').length >= 2;
    const { jsdomErrors, unhandled } = await renderThenCloseBeforeReadSettles(
      `/accounts/${encodeURIComponent(operatorDid)}`,
      300,
      rosterPainted,
    );
    expect(jsdomErrors, `jsdom errors: ${jsdomErrors.join('; ')}`).toEqual([]);
    expect(unhandled.map(String), 'a late read wrote into a closed page').toEqual([]);
  });
});
