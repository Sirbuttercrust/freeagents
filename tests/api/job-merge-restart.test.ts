// D2 fix (Proof round 1, task t_8a82c865): identity resolution must not
// depend on process warmth. The anchor: "a stranger derives the same
// verificationMethod from the keyid whether or not this process happened
// to be running when the agent last signed" -- so this process must not
// either. Before this fix, KnownKeyStore was an in-process Map with no
// durable backing: a restart between an agent's last signed request and
// POST /jobs/:jobId/merge permanently 503'd the merge, with no
// agent-drivable recovery (every re-teaching route 409s once the job is
// submitted). This test reproduces the restart exactly as Proof did: one
// app instance walks the H1 chain up through the pull request, is closed
// (simulating the process exiting), and a SECOND app instance -- sharing
// only durable storage, with a fresh in-process KnownKeyStore, the same
// shape a real restart leaves -- completes the merge.
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { GithubAdapter, PullRequestRef } from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
  MemoryObservedKeyRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const FORK_OWNER = 'freeagents-platform';
const FORK_REPO = 'target-repo';
const PR_NUMBER = 21;
const MERGE_SHA = 'restart-merge-sha';
const MERGED_AT = new Date('2026-08-31T10:00:00Z');

function fakeGithub(): GithubAdapter {
  return {
    getPullRequest: (ref: PullRequestRef) =>
      Promise.resolve({
        ref,
        state: 'merged',
        mergeCommitSha: MERGE_SHA,
        mergedAt: MERGED_AT,
        headSha: 'restart-head-sha',
        additions: 8,
        deletions: 2,
        filesChanged: 1,
        repositoryPublic: true,
      }),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    forkAndOpenPullRequest: () => Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: PR_NUMBER }),
  };
}

async function postSigned(base: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${base}${path}`;
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

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('POST /jobs/:jobId/merge survives a process restart between the last signed request and merge', () => {
  let servers: Server[] = [];

  afterEach(() => {
    for (const server of servers) server.close();
    servers = [];
  });

  it('completes the merge against a fresh process sharing only durable storage (D2, task t_8a82c865)', async () => {
    const agentIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(121));
    const buyerIdentity = await signingIdentityFromSeed(new Uint8Array(32).fill(122));

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agentIdentity.did,
      operatorDid: 'did:abt:op-restart',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyerIdentity.did, githubLogin: 'buyer-restart' });
    const jobRepo = new MemoryJobRepository();
    const credentialRepo = new MemoryCredentialRepository();
    const observedKeyRepo = new MemoryObservedKeyRepository();
    const credentials = createCredentialsAdapter(
      { did: 'did:abt:platform-restart', seed: new Uint8Array(32).fill(19) },
      credentialRepo,
    );

    // Process 1: identity is undefined so createApp wires its OWN real
    // adapter with its OWN fresh in-process KnownKeyStore -- the durable
    // repositories are the only thing shared with process 2 below.
    const app1 = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      fakeGithub(),
      jobRepo,
      credentials,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      observedKeyRepo,
    );
    const first = await listen(app1);
    servers.push(first.server);

    const draft = await postSigned(first.baseUrl, '/jobs', {
      agentDid: agentIdentity.did,
      repository: 'buyer/target-repo',
      brief: 'Fix the checkout timeout',
    }, buyerIdentity);
    expect(draft.status).toBe(201);
    const jobId = String(((await draft.json()) as Record<string, unknown>).id);

    // The agent's only signed request in this process: what teaches the
    // (process-1) KnownKeyStore, and now must also teach durable storage.
    expect(
      (
        await postSigned(first.baseUrl, `/jobs/${jobId}/criteria`, {
          criteria: [
            { text: 'The checkout no longer times out', proposedBy: 'agent' },
            { text: 'Load test passes', proposedBy: 'buyer' },
          ],
        }, agentIdentity)
      ).status,
    ).toBe(200);
    expect((await postSigned(first.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(first.baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(first.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(first.baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agentIdentity)).status).toBe(200);
    expect((await postSigned(first.baseUrl, `/jobs/${jobId}/confirm`, {}, buyerIdentity)).status).toBe(200);
    expect((await postSigned(first.baseUrl, `/jobs/${jobId}/pull-request`, {}, agentIdentity)).status).toBe(200);

    // The process exits. Nothing about process 1 survives into process 2
    // except the durable repositories.
    first.server.close();

    const app2 = createApp(
      operatorRepo,
      agentRepo,
      undefined,
      fakeGithub(),
      jobRepo,
      credentials,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      observedKeyRepo,
    );
    const second = await listen(app2);
    servers.push(second.server);

    const merge = await postSigned(second.baseUrl, `/jobs/${jobId}/merge`, {}, buyerIdentity);
    expect(merge.status).toBe(200);
    const mergeBody = (await merge.json()) as Record<string, unknown>;
    expect(mergeBody.status).toBe('completed');
    const credential = mergeBody.credential as Record<string, unknown>;
    const hire = (credential.credentialSubject as Record<string, unknown>).hire as Record<string, unknown>;
    expect(hire.signedBy).toBe(agentIdentity.keyid);
  });
});
