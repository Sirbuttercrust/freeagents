// FIX-SW12k (SW3-09): the accounts the notification cases on /notifications
// and /dashboard need. One real app with a notification store the test can
// seed, one session adapter whose GitHub login is switched before each mint,
// so every account below is its own row provisioned by the app itself.
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
  MemoryNotificationRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { createNotification } from '../../src/domain/notification.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession, type FakeGitHubUser } from './session-fixtures.js';

export interface NotificationAccount {
  readonly session: Session;
  readonly did: string;
  // Seeded oldest first; each notification concerns its own job.
  readonly unread: readonly { readonly id: string; readonly jobId: string }[];
  readonly read: readonly { readonly id: string; readonly jobId: string }[];
}

export interface AccountOptions {
  readonly unread: number;
  readonly read: number;
  // One agent on the roster that needs nothing from the dashboard: a
  // verified hire on record and GitHub confirmed, so section 3 stays empty.
  // No payout address is set, so the payout notice shows.
  readonly settledAgent?: boolean;
}

export interface NotificationWorld {
  readonly baseUrl: string;
  readonly notifications: MemoryNotificationRepository;
  account(name: string, options: AccountOptions): Promise<NotificationAccount>;
  unreadCountOf(account: NotificationAccount): Promise<number>;
  // A second server in front of the real one. A request whose path matches
  // `fails` is answered 503 (mode 'status') or has its socket destroyed
  // with no answer at all (mode 'drop'); every other request passes through.
  failing(fails: (path: string) => boolean, mode: 'status' | 'drop'): Promise<{ baseUrl: string; close: () => Promise<void> }>;
  close(): Promise<void>;
}

function delegation(agentDid: string, operatorDid: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:notif-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-09-29T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: { type: 'Ed25519Signature2020', created: '2026-09-29T00:00:00Z', verificationMethod: `${agentDid}#key-1`, proofPurpose: 'assertionMethod', proofValue: 'zfixture-not-verified-here' },
  };
}

// The caller sets FREEAGENTS_PLATFORM_SEED first: /accounts/me provisions an
// account for a new session only when it is set.
export async function startNotificationWorld(prefix: string): Promise<NotificationWorld> {
  const accountRepo = new MemoryAccountRepository();
  const agentRepo = new MemoryAgentRepository();
  const credentialRepo = new MemoryCredentialRepository();
  const notifications = new MemoryNotificationRepository();
  let user: FakeGitHubUser = { login: `${prefix}-0`, id: 1 };
  const sessionAdapter = createSessionAdapter({
    github: fakeGitHubConfig(),
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => fakeGitHubFetch(user)(input, init)) as typeof fetch,
  });
  const u = undefined;
  const app = createApp(
    accountRepo, agentRepo, u, u, new MemoryJobRepository(), u, u, credentialRepo, u, u, u, sessionAdapter,
    u, u, u, u, u, u, u, u, u, u, u, notifications,
  );
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const realPort = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${realPort}`;
  let nextId = 9700;

  async function account(name: string, options: AccountOptions): Promise<NotificationAccount> {
    nextId += 1;
    user = { login: `${prefix}-${name}`, id: nextId };
    const session = await mintSession(sessionAdapter);
    const res = await fetch(`${baseUrl}/accounts/me`, { headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` } });
    if (res.status !== 200) throw new Error(`GET /accounts/me answered ${res.status} for ${name}`);
    const did = ((await res.json()) as { did: string }).did;

    const unread: { id: string; jobId: string }[] = [];
    const read: { id: string; jobId: string }[] = [];
    const total = options.unread + options.read;
    for (let i = 0; i < total; i++) {
      const id = `${prefix}-${name}-n${i}`;
      const jobId = `j-${prefix}-${name}-${i}`;
      await notifications.create(createNotification({ id, accountDid: did, jobId, eventType: 'new_message' }, new Date(Date.UTC(2026, 8, 1 + i))));
      // The first `read` of them are read, the rest unread, so read and
      // unread rows interleave with neither group all at one end.
      if (i < options.read) {
        await notifications.markRead(id, did, new Date(Date.UTC(2026, 8, 20)));
        read.push({ id, jobId });
      } else {
        unread.push({ id, jobId });
      }
    }

    if (options.settledAgent === true) {
      const agentDid = `did:abt:${prefix}-${name}-agent`;
      await agentRepo.create({ did: agentDid, operatorDid: did, delegation: delegation(agentDid, did), name: `${name}-agent`, skills: [], githubLogin: `${prefix}-${name}-gh` });
      await agentRepo.updateGithubBinding(agentDid, { handle: `${prefix}-${name}-gh`, status: 'verified' });
      await credentialRepo.save({
        completedJobId: `${prefix}-${name}-done`,
        subjectDid: agentDid,
        document: {
          '@context': ['https://www.w3.org/ns/credentials/v2'],
          id: `https://platform.example/v1/credentials/${prefix}-${name}-done`,
          type: ['VerifiableCredential', 'CompletedHireCredential'],
          issuer: 'did:abt:platform',
          validFrom: '2026-08-30T00:00:00.000Z',
          credentialSubject: {
            id: agentDid,
            hire: {
              brief: 'sha256:brief', repository: 'buyer/target-repo', pullRequest: 'https://github.com/buyer/target-repo/pull/1',
              mergedAt: '2026-08-30T00:00:00.000Z', mergeCommit: `${prefix}-${name}-commit`, signedBy: `${agentDid}#key-1`,
              buyer: 'did:example:notif-buyer', additions: 4, deletions: 1, filesChanged: 1,
            },
          },
          proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
        },
        repositoryPublic: true,
      });
    }
    return { session, did, unread, read };
  }

  async function unreadCountOf(a: NotificationAccount): Promise<number> {
    const res = await fetch(`${baseUrl}/accounts/${encodeURIComponent(a.did)}/notifications`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${a.session.token}` },
    });
    if (res.status !== 200) throw new Error(`GET notifications answered ${res.status}`);
    return ((await res.json()) as { unreadCount: number }).unreadCount;
  }

  async function failing(fails: (path: string) => boolean, mode: 'status' | 'drop'): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const proxy = http.createServer((req, res) => {
      if (req.url !== undefined && fails(req.url)) {
        if (mode === 'drop') {
          req.socket.destroy();
          return;
        }
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
      close: () => new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
    };
  }

  return {
    baseUrl,
    notifications,
    account,
    unreadCountOf,
    failing,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
