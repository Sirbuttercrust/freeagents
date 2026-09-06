// P6 (design record, 2026-09-01, row 3): the deemed-completion credential
// issued the instant a submitted job's deadline lapses with no merge and no
// cited close. deemCompleted itself already carries the domain clock
// (tests/domain/job-clocks.test.ts); this file proves the route layer's own
// job -- applyLiveLapses issues the distinct DeemedCompletionCredential type
// exactly once, at the choke point every mutation and GET route shares
// (see applyLiveLapses's own header comment), and GET /jobs/:jobId resolves
// it as a sibling of the projection the same way a merge credential rides.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import {
  isCompletedHireCredential,
  type CredentialsAdapter,
  type DeemedCompletionCredential,
  type DeemedCompletionClaim,
} from '../../src/adapters/credentials/types.js';
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

  // P6 review round 3, D5 (t_604e3f2a): issuance used to be attempted
  // exactly once, on the instant applyLiveLapses observes the transition
  // (`if (lapsed.status === job.status) return job;` skipped every later
  // read before issuance was ever reconsidered). A transient signing fault
  // on that one attempt destroyed the credential permanently, with no
  // retry route -- unlike the merge route, which a caller retries and
  // which re-enters issuance. This test wraps the real signer so it fails
  // on its first call for the flaky job and succeeds after, with a
  // healthy job proven alive through the identical path as a positive
  // control (a test that only checked the failing leg would pass on a
  // build where issuance never fires at all).
  it('a transient issuance failure is recovered on a later read, proven against a healthy positive control', async () => {
    const flakyJobId = 'j-deemed-flaky';
    const healthyJobId = 'j-deemed-healthy';
    await jobRepo.create(submittedJob(flakyJobId));
    await jobRepo.create(submittedJob(healthyJobId));

    const realCredentials = createCredentialsAdapter({ did: ISSUER_DID, seed: ISSUER_SEED }, credentialRepo);
    let flakyAttempts = 0;
    const flakyCredentials: CredentialsAdapter = {
      ...realCredentials,
      issueDeemedCompletionCredential(subjectDid: string, claim: DeemedCompletionClaim) {
        if (claim.jobId === flakyJobId) {
          flakyAttempts += 1;
          if (flakyAttempts === 1) {
            return Promise.reject(new Error('signing key unavailable'));
          }
        }
        return realCredentials.issueDeemedCompletionCredential(subjectDid, claim);
      },
    };
    const flakyApp = createApp(
      new MemoryAccountRepository(),
      new MemoryAgentRepository(),
      undefined,
      undefined,
      jobRepo,
      flakyCredentials,
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
    const flakyServer = flakyApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => flakyServer.once('listening', resolve));
    const address = flakyServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const flakyBaseUrl = `http://127.0.0.1:${address.port}`;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Positive control: the healthy job issues on the very first read,
      // proving the instrument (this app, this adapter) actually fires
      // issuance through this exact path.
      const controlRes = await get(flakyBaseUrl, `/jobs/${healthyJobId}`);
      const controlBody = (await controlRes.json()) as Record<string, unknown>;
      expect(controlBody.status).toBe('deemed_completed');
      expect(controlBody.credential).toBeDefined();

      // The flaky job: first read observes the transition but the signer
      // fails, so the job is deemed_completed with no credential.
      const firstRes = await get(flakyBaseUrl, `/jobs/${flakyJobId}`);
      const firstBody = (await firstRes.json()) as Record<string, unknown>;
      expect(firstBody.status).toBe('deemed_completed');
      expect(firstBody.credential).toBeUndefined();
      expect(await credentialRepo.findByDocumentId(flakyJobId)).toBeNull();

      // A later read, signer healthy again: the credential is recovered,
      // not lost forever. This is the behavior the old code's comment
      // claimed ("re-derivable ... rather than a silently skipped
      // issuance") without actually providing.
      const secondRes = await get(flakyBaseUrl, `/jobs/${flakyJobId}`);
      const secondBody = (await secondRes.json()) as Record<string, unknown>;
      expect(secondBody.status).toBe('deemed_completed');
      expect(secondBody.credential).toBeDefined();
      const recovered = secondBody.credential as DeemedCompletionCredential;
      expect(recovered.type).toContain('DeemedCompletionCredential');
      expect(await credentialRepo.findByDocumentId(flakyJobId)).not.toBeNull();

      // Exactly one credential row for the flaky job even though issuance
      // was attempted twice: the repository's own duplicate guard
      // (CredentialAlreadyIssuedError) is what makes a retry safe, and it
      // must not fire here since the first attempt never reached save.
      expect(flakyAttempts).toBe(2);
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve) => flakyServer.close(() => resolve()));
    }
  });
});
