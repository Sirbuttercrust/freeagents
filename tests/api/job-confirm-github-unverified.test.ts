// B28 (bug ledger, C1 rehearsal s4 and s6): confirm answered 503 "github
// unavailable" when the real cause was that the agent has no verified
// GitHub login -- a caller was told to retry something that would never
// work no matter how many times it tried. The fix distinguishes the two
// causes: an agent with no verified GitHub login is a state conflict named
// on the job (409), not a transient service fault (503, kept for a real
// GitHub outage -- see job-confirm-staging.test.ts, which pins that path
// untouched).
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(232));

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
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
}

async function startApp(agentRepo: MemoryAgentRepository): Promise<Started> {
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-confirm-github-${Math.random()}` });
  const jobRepo = new MemoryJobRepository();
  const { github } = createStagingLifecycleGithubFake();
  const app = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    github,
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
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function walkToPriceAccepted(baseUrl: string): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/confirm-github-repo',
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

describe('POST /jobs/:jobId/confirm: an agent with no verified GitHub login (B28)', () => {
  it('answers 409 naming the missing verified login, never 503, when the agent has no githubLogin at all', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-confirm-github',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const { server, baseUrl } = await startApp(agentRepo);
    try {
      const jobId = await walkToPriceAccepted(baseUrl);
      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(409);
      const body = (await confirm.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('verified github login');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('answers 409, not 503, when the agent has a githubLogin but proofStatus is not verified', async () => {
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-confirm-github',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-confirm-github',
    });
    // create() alone leaves proofStatus 'unverified' (memory.ts's own
    // default): a login name is present, but nothing has proved it yet.
    const { server, baseUrl } = await startApp(agentRepo);
    try {
      const jobId = await walkToPriceAccepted(baseUrl);
      const confirm = await postSigned(baseUrl, `/jobs/${jobId}/confirm`, {}, buyer);
      expect(confirm.status).toBe(409);
      const body = (await confirm.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('verified github login');

      // The row never budged off proposed: a state conflict, not a write.
      const read = await fetch(`${baseUrl}/jobs/${jobId}`);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.status).toBe('proposed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
