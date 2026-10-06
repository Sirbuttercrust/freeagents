// FIX-SW12g (SW3-10): the accounts the payout-notice cases on /myagents and
// /dashboard need, each a real account the real app provisioned from its
// own session, with its roster and payout addresses set through the real
// repositories. One app, one session adapter whose GitHub login is switched
// before each mint, so every account below is a distinct row rather than
// the same person signed in five times.
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { RealBrowser } from './real-browser.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession, type FakeGitHubUser } from './session-fixtures.js';

// The notice's whole sentence and its one destination, named once so a
// test on either page asserts the same words.
export const PAYOUT_NOTICE_SENTENCE = 'Hirers cannot pay you until you add a payout address.';
export const PAYOUT_NOTICE_HREF = '/settings';

export interface PayoutAccount {
  readonly session: Session;
  readonly did: string;
}

export interface PayoutWorld {
  readonly baseUrl: string;
  // Both addresses null, one agent on the roster: the notice shows.
  readonly noAddress: PayoutAccount;
  // One agent, only the EVM (USDC) address set.
  readonly evmOnly: PayoutAccount;
  // One agent, only the ABT address set.
  readonly abtOnly: PayoutAccount;
  // One agent, only the ABT-on-Ethereum address set.
  readonly abtEthOnly: PayoutAccount;
  // Both addresses null and no agents: a person who only hires.
  readonly noAgents: PayoutAccount;
  // A second server in front of the real one that answers any request
  // whose path matches `fails` with the API's storage error (503) and
  // passes every other request through untouched.
  failing(fails: (path: string) => boolean): Promise<{ baseUrl: string; close: () => Promise<void> }>;
  close(): Promise<void>;
}

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:payout-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-29T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: { type: 'Ed25519Signature2020', created: '2026-09-29T00:00:00Z', verificationMethod: `${agentDid}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture-not-verified-here' },
  };
}

// The caller sets FREEAGENTS_PLATFORM_SEED first: /accounts/me provisions
// an account for a new session only when it is set.
export async function startPayoutWorld(prefix: string): Promise<PayoutWorld> {
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  let user: FakeGitHubUser = { login: `${prefix}-0`, id: 1 };
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => fakeGitHubFetch(user)(input, init)) as typeof fetch,
  });
  const app = createApp(
    accountRepo, agentRepo, undefined, undefined, new MemoryJobRepository(), undefined,
    undefined, new MemoryCredentialRepository(), undefined, undefined, undefined, sessionAdapter,
  );
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const realPort = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${realPort}`;

  async function account(name: string, id: number, agents: number): Promise<PayoutAccount> {
    user = { login: `${prefix}-${name}`, id };
    const session = await mintSession(sessionAdapter);
    const res = await fetch(`${baseUrl}/accounts/me`, { headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` } });
    if (res.status !== 200) throw new Error(`GET /accounts/me answered ${res.status} for ${name}`);
    const did = ((await res.json()) as { did: string }).did;
    for (let i = 0; i < agents; i++) {
      const agentDid = `did:abt:${prefix}-${name}-agent-${i}`;
      await agentRepo.create({ did: agentDid, operatorDid: did, delegation: delegation(agentDid, did), name: `${name}-agent-${i}`, skills: [], githubLogin: null });
    }
    return { session, did };
  }

  const noAddress = await account('none', 9901, 1);
  const evmOnly = await account('evm', 9902, 1);
  await accountRepo.setOperatorAddressEvm(evmOnly.did, `0x${'ab'.repeat(20)}`);
  const abtOnly = await account('abt', 9903, 1);
  await accountRepo.setOperatorAddressAbt(abtOnly.did, 'zPayoutNoticeAbtAddress');
  const abtEthOnly = await account('abt-eth', 9905, 1);
  await accountRepo.setOperatorAddressAbtEth(abtEthOnly.did, `0x${'cd'.repeat(20)}`);
  const noAgents = await account('hirer', 9904, 0);

  async function failing(fails: (path: string) => boolean): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const proxy = http.createServer((req, res) => {
      if (req.url !== undefined && fails(req.url)) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'storage unavailable' }));
        return;
      }
      const upstream = http.request(
        { hostname: '127.0.0.1', port: realPort, path: req.url, method: req.method, headers: req.headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    return {
      baseUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      close: () => new Promise<void>((resolve) => proxy.close(() => resolve())),
    };
  }

  return {
    baseUrl,
    noAddress,
    evmOnly,
    abtOnly,
    abtEthOnly,
    noAgents,
    failing,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Text a person can see: the body with every hidden subtree, template,
// script and style removed, whitespace collapsed.
export function visibleText(document: Document): string {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll('[hidden], template, script, style').forEach((el) => el.remove());
  return (body.textContent ?? '').replace(/\s+/g, ' ');
}

// Every visible link on the page whose href is the notice's destination
// and whose own text sits inside the notice's sentence.
export function noticeLinks(document: Document): Element[] {
  return Array.from(document.querySelectorAll(`a[href="${PAYOUT_NOTICE_HREF}"]`)).filter(
    (a) => a.closest('[hidden]') === null && (a.closest('p, div, b')?.textContent ?? '').replace(/\s+/g, ' ').includes(PAYOUT_NOTICE_SENTENCE),
  );
}

export interface NoticeGeometry {
  readonly width: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  // The notice link's painted box, or null when no visible link rendered.
  readonly link: { readonly width: number; readonly height: number } | null;
}

// Loads `path` signed in as `session` in a real Chrome at each width and
// reads the page's sideways scroll and the notice link's box. The session
// is stored on the origin first, then the page is loaded again so its own
// script reads it, the same two-step the /myagents layout test takes.
export async function measureNotice(baseUrl: string, path: string, session: Session, widths: readonly number[]): Promise<NoticeGeometry[]> {
  const browser = await RealBrowser.launch({ width: widths[0] ?? 320, height: 900 });
  try {
    await browser.goto(`${baseUrl}${path}`);
    await browser.evaluate(`sessionStorage.setItem('fa_session', ${JSON.stringify(JSON.stringify(session))})`);
    const out: NoticeGeometry[] = [];
    for (const width of widths) {
      await browser.setViewport(width, 900);
      await browser.goto(`${baseUrl}${path}`, 800);
      const g = await browser.evaluate<Omit<NoticeGeometry, 'width'>>(`
        (function () {
          var a = document.querySelector('#payout-notice a');
          var box = a && a.closest('[hidden]') === null ? a.getBoundingClientRect() : null;
          return {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            link: box && box.height > 0 ? { width: box.width, height: box.height } : null,
          };
        })()
      `);
      out.push({ width, ...g });
    }
    return out;
  } finally {
    await browser.close();
  }
}
