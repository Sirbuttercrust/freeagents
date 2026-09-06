// P6 (design record, 2026-09-01, row 3): the deemed-completion credential
// issued the instant a submitted job's deadline lapses with no merge and no
// cited close. deemCompleted itself already carries the domain clock
// (tests/domain/job-clocks.test.ts); this file proves the route layer's own
// job -- applyLiveLapses issues the distinct DeemedCompletionCredential type
// exactly once, at the choke point every mutation and GET route shares
// (see applyLiveLapses's own header comment), and GET /jobs/:jobId resolves
// it as a sibling of the projection the same way a merge credential rides.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { isCompletedHireCredential, type DeemedCompletionCredential } from '../../src/adapters/credentials/types.js';
import { MemoryAgentRepository, MemoryCredentialRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { signingIdentityFromSeed, type SigningIdentity } from '../helpers/sign-request.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';

const ISSUER_DID = 'did:abt:test-platform-issuer';
const ISSUER_SEED = new Uint8Array(32).fill(9);

let buyer: SigningIdentity;
let agent: SigningIdentity;

const SUBMITTED_AT = new Date('2026-01-10T00:00:00Z');

function submittedJob(id: string): Job {
  return {
    ...createJob(
      { id, buyerDid: buyer.did, agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' },
      new Date(SUBMITTED_AT.getTime() - 86_400_000),
    ),
    status: 'submitted',
    confirmedSpecHash: 'sha256:spec',
    confirmedAt: new Date(SUBMITTED_AT.getTime() - 43_200_000),
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [{ text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    stagedCommit: 'commit-sha-deemed',
    stagedAt: new Date(SUBMITTED_AT.getTime() - 21_600_000),
    pullRequestUrl: 'https://github.com/freeagents-platform/target-repo/pull/1',
    submittedAt: SUBMITTED_AT,
    deadline: new Date(SUBMITTED_AT.getTime() + 30 * 86_400_000),
  };
}

async function get(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`);
}

describe('deemed-completion credential issuance (P6, design record row 3)', () => {
  let server: Server;
  let baseUrl: string;
  let jobRepo: MemoryJobRepository;
  let credentialRepo: MemoryCredentialRepository;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(141));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(142));
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: buyer.did, githubLogin: 'buyer-deemed' });
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: 'did:abt:op-deemed',
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    jobRepo = new MemoryJobRepository();
    credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter({ did: ISSUER_DID, seed: ISSUER_SEED }, credentialRepo);
    const app = createApp(
      accounts,
      agentRepo,
      undefined,
      undefined,
      jobRepo,
      credentials,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => server.close());

  it('a submitted job 8 days past submittedAt deems complete on GET and carries a distinct credential', async () => {
    const jobId = 'j-deemed-1';
    await jobRepo.create(submittedJob(jobId));

    const res = await get(baseUrl, `/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('deemed_completed');
    expect(body.credential).toBeDefined();
    const credential = body.credential as DeemedCompletionCredential;
    expect(credential.type).toContain('DeemedCompletionCredential');
    expect(isCompletedHireCredential(credential)).toBe(false);
    expect(credential.credentialSubject.deemedCompletion.noMerge).toBe(true);
    expect(credential.credentialSubject.deemedCompletion.stagedCommit).toBe('commit-sha-deemed');

    const stored = await credentialRepo.findByDocumentId(jobId);
    expect(stored).not.toBeNull();
  });

  it('the deemed-completion credential is a distinct type from a completed hire credential', async () => {
    const jobId = 'j-deemed-2';
    await jobRepo.create(submittedJob(jobId));
    await get(baseUrl, `/jobs/${jobId}`);
    const stored = await credentialRepo.findByDocumentId(jobId);
    if (stored === null) throw new Error('expected a stored credential');
    expect(isCompletedHireCredential(stored)).toBe(false);
  });

  it('a deemed-completed job has exactly one credential after two lapse passes (GET twice)', async () => {
    const jobId = 'j-deemed-3';
    await jobRepo.create(submittedJob(jobId));
    const first = await get(baseUrl, `/jobs/${jobId}`);
    expect(((await first.json()) as Record<string, unknown>).status).toBe('deemed_completed');
    const second = await get(baseUrl, `/jobs/${jobId}`);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.status).toBe('deemed_completed');
    // The second pass's own credential id equals the stored one: one row,
    // not two, since applyLiveLapses only fires issuance on the instant
    // the transition itself happens (lapsed.status === job.status returns
    // early on every later read, before issuance is ever considered).
    const stored = await credentialRepo.findByDocumentId(jobId);
    if (stored === null) throw new Error('expected a stored credential');
    expect((secondBody.credential as DeemedCompletionCredential).id).toBe(stored.id);
  });
});
