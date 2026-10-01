// FIX-B14b (B14b): confirm's own thread gets one staging_invited
// row when the collaborator grant it just made came back a pending
// invitation, naming GitHub's own accept link -- because after confirm
// answers 200, the agent has NO push access to the repository it was just
// told to push to until it accepts. An `active` grant (already a
// collaborator) writes no row: there is no accept step to name.
//
// The party that did not confirm is notified (either party may confirm,
// app.ts's own note); the confirming party is not notified of its own
// action, the same excludeDid stance every other thread-triggered
// notification in this file already takes. A thread-write failure never
// turns a successful, persisted confirm into a 503 (best-effort, logged),
// matching every other system row in this file.
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import type { MessageRepository } from '../../src/adapters/storage/types.js';
import {
  MemoryAgentRepository,
  MemoryAccountRepository,
  MemoryJobRepository,
  MemoryMessageRepository,
  MemoryNotificationRepository,
} from '../../src/adapters/storage/memory.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import {
  createStagingLifecycleGithubFake,
  PLATFORM_LOGIN,
  type StagingLifecycleFixture,
} from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const AGENT_GITHUB_LOGIN = 'scout-confirm-invited';

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly messageRepo: MessageRepository;
  readonly notificationRepo: MemoryNotificationRepository;
  readonly fixture: StagingLifecycleFixture;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
}

async function startApp(
  buildFixture: () => StagingLifecycleFixture = () => createStagingLifecycleGithubFake(),
): Promise<Started> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(232));
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-confirm-invited-${Math.random()}` });
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: 'did:abt:op-confirm-invited',
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: AGENT_GITHUB_LOGIN,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const messageRepo = new MemoryMessageRepository();
  const notificationRepo = new MemoryNotificationRepository();
  const fixture = buildFixture();
  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    fixture.github,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    alwaysSettledGate(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    messageRepo,
    undefined,
    notificationRepo,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, messageRepo, notificationRepo, fixture, buyer, agent };
}

async function walkToPriceAccepted(baseUrl: string, buyer: SigningIdentity, agent: SigningIdentity): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/confirm-invited-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agent);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
  await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent);
  return jobId;
}

let active: Started | null = null;
afterEach(async () => {
  if (active !== null) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = null;
  }
});

describe('POST /jobs/:jobId/confirm: staging_invited system row (FIX-B14b)', () => {
  it('an invited grant writes one staging_invited row naming the accept URL and login, and notifies the party that did not confirm', async () => {
    const fixture = createStagingLifecycleGithubFake();
    active = await startApp(() => fixture);
    const jobId = await walkToPriceAccepted(active.baseUrl, active.buyer, active.agent);
    fixture.setGrantPushState(PLATFORM_LOGIN, `staging-${jobId}`, AGENT_GITHUB_LOGIN, 'invited');

    const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
    expect(confirm.status).toBe(200);
    // The response shape is unchanged: still exactly the pinned key set,
    // no new field for this row.
    const body = (await confirm.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'agentDid',
      'baseCommit',
      'brief',
      'briefHash',
      'buyerDid',
      'confirmedAt',
      'createdAt',
      'criteria',
      'id',
      'price',
      'repository',
      'specHash',
      'stagingRepo',
      'status',
    ]);

    const messages = await active.messageRepo.listByJobId(jobId);
    const invitedRows = messages.filter((m) => m.systemEvent?.type === 'staging_invited');
    expect(invitedRows).toHaveLength(1);
    expect(invitedRows[0]?.systemEvent).toEqual({
      type: 'staging_invited',
      acceptUrl: `https://github.com/${PLATFORM_LOGIN}/staging-${jobId}/invitations`,
      githubLogin: AGENT_GITHUB_LOGIN,
    });
    expect(invitedRows[0]?.body).toContain(AGENT_GITHUB_LOGIN);
    expect(invitedRows[0]?.body).toContain(`https://github.com/${PLATFORM_LOGIN}/staging-${jobId}/invitations`);

    // The buyer confirmed; the agent's operator did not, so it is the one
    // notified, and the buyer is not notified of its own action.
    const operatorNotifications = await active.notificationRepo.listByAccountDid('did:abt:op-confirm-invited');
    expect(operatorNotifications.some((n) => n.jobId === jobId && n.eventType === 'new_message')).toBe(true);
    const buyerNotifications = await active.notificationRepo.listByAccountDid(active.buyer.did);
    expect(buyerNotifications.some((n) => n.jobId === jobId && n.eventType === 'new_message')).toBe(false);
  });

  it('an active grant (already a collaborator) writes no staging_invited row', async () => {
    active = await startApp();
    const jobId = await walkToPriceAccepted(active.baseUrl, active.buyer, active.agent);

    const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
    expect(confirm.status).toBe(200);

    const messages = await active.messageRepo.listByJobId(jobId);
    expect(messages.some((m) => m.systemEvent?.type === 'staging_invited')).toBe(false);
  });

  it('a thread write failure still answers 200 and persists the confirmed job (best-effort, logged)', async () => {
    const fixture = createStagingLifecycleGithubFake();
    active = await startApp(() => fixture);
    const jobId = await walkToPriceAccepted(active.baseUrl, active.buyer, active.agent);
    fixture.setGrantPushState(PLATFORM_LOGIN, `staging-${jobId}`, AGENT_GITHUB_LOGIN, 'invited');

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const createSpy = vi.spyOn(active.messageRepo, 'create').mockRejectedValueOnce(new Error('storage down'));
    try {
      const confirm = await postSigned(active.baseUrl, `/jobs/${jobId}/confirm`, {}, active.buyer);
      expect(confirm.status).toBe(200);
      const body = (await confirm.json()) as Record<string, unknown>;
      expect(body.status).toBe('confirmed');
      expect(errorLog).toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      errorLog.mockRestore();
    }
  });
});
