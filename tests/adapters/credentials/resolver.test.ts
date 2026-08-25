// R-15, the serve-only adapter: what the app ships before R-13 wires the
// platform issuer in. Its honesty is the contract under test: the half it
// does not have throws the named capability error instead of returning
// undefined or a stubbed document, and the half it does have (resolution)
// comes back from the repository it was handed, by id or by full credential
// id, with the null arm mapping to the 404's domain error.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCredentialResolver,
  createCredentialsAdapter,
} from '../../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential, WorkHistoryClaim } from '../../../src/adapters/credentials/types.js';
import { NotImplementedError } from '../../../src/adapters/not-implemented.js';
import { MemoryCredentialRepository } from '../../../src/adapters/storage/memory.js';
import { CredentialNotFoundError } from '../../../src/adapters/storage/types.js';

const claim: WorkHistoryClaim = {
  jobId: 'job-1',
  pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
  mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
  mergedAt: '2026-01-03T00:00:00.000Z',
  diffAdditions: 1,
  diffDeletions: 1,
  diffFiles: 1,
  briefHash: 'sha256:brief',
  specHash: 'sha256:spec',
  repository: 'buyer/target-repo',
  signedBy: 'did:abt:agent#job-1',
  buyerDid: 'did:example:buyer',
};

// Used by the specHash-omission pin below: a job that completed without a
// confirmed spec.
const claimWithoutSpec: WorkHistoryClaim = { ...claim, specHash: null };

const document: VerifiableCredential = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id: 'urn:uuid:00000000-0000-4000-8000-000000000000',
  type: ['VerifiableCredential', 'CompletedHireCredential'],
  issuer: 'did:abt:platform',
  validFrom: '2026-01-03T00:00:00.000Z',
  credentialSubject: {
    id: 'did:abt:agent',
    hire: {
      brief: claim.briefHash,
      repository: claim.repository,
      pullRequest: claim.pullRequestUrl,
      mergedAt: claim.mergedAt,
      mergeCommit: claim.mergeCommitSha,
      signedBy: claim.signedBy,
      buyer: claim.buyerDid,
      additions: claim.diffAdditions,
      deletions: claim.diffDeletions,
      filesChanged: claim.diffFiles,
      specHash: claim.specHash as string,
    },
  },
  proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
};

describe('createCredentialResolver (R-15, before R-13 wires the issuer)', () => {
  it('issuance throws the named capability error, not a stub document', () => {
    const resolver = createCredentialResolver(new MemoryCredentialRepository());

    // The stub throws synchronously, so the assertion wraps the call itself
    // rather than awaiting a rejection, the same way the github stub tests do.
    expect(() => resolver.issueWorkHistoryCredential('did:abt:agent', claim)).toThrowError(
      NotImplementedError,
    );
  });

  it('verification is deliberately external (invariant 2), so it throws the named capability error too', () => {
    const resolver = createCredentialResolver(new MemoryCredentialRepository());

    expect(() => resolver.verifyCredential(document)).toThrowError(NotImplementedError);
  });

  it('resolution comes back from the repository it was handed, by full credential id', async () => {
    const repo = new MemoryCredentialRepository();
    await repo.save({ completedJobId: 'job-1', subjectDid: 'did:abt:agent', document });
    const resolver = createCredentialResolver(repo);

    await expect(
      resolver.getCredential('https://platform.example/v1/credentials/job-1'),
    ).resolves.toEqual(document);
  });

  it('resolution maps a missing id to CredentialNotFoundError, the 404 arm', async () => {
    const resolver = createCredentialResolver(new MemoryCredentialRepository());

    await expect(resolver.getCredential('never-issued')).rejects.toBeInstanceOf(CredentialNotFoundError);
  });
});

describe('createCredentialsAdapter, the parts R-15 did not touch', () => {
  const ORIGINAL_DID = process.env.FREEAGENTS_PLATFORM_DID;
  const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (ORIGINAL_DID === undefined) {
      delete process.env.FREEAGENTS_PLATFORM_DID;
    } else {
      process.env.FREEAGENTS_PLATFORM_DID = ORIGINAL_DID;
    }
    if (ORIGINAL_SEED === undefined) {
      delete process.env.FREEAGENTS_PLATFORM_SEED;
    } else {
      process.env.FREEAGENTS_PLATFORM_SEED = ORIGINAL_SEED;
    }
  });

  it('called with no issuer, it defaults to the env-derived platform issuer (R-35)', async () => {
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', 'did:abt:zEnvPlatform');
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', 'c3'.repeat(32));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const adapter = createCredentialsAdapter(undefined, new MemoryCredentialRepository());
    const credential = await adapter.issueWorkHistoryCredential('did:abt:agent', claim);

    expect(credential.issuer).toBe('did:abt:zEnvPlatform');
  });

  it('verification still throws the named capability error (invariant 2 is external)', () => {
    const adapter = createCredentialsAdapter(
      { did: 'did:abt:platform', seed: new Uint8Array(32) },
      new MemoryCredentialRepository(),
    );

    expect(() => adapter.verifyCredential(document)).toThrowError(NotImplementedError);
  });

  it('omits specHash from the wire when the claim has none, and includes it when the claim has one', async () => {
    const adapter = createCredentialsAdapter(
      { did: 'did:abt:platform', seed: new Uint8Array(32) },
      new MemoryCredentialRepository(),
    );

    const withoutSpec = await adapter.issueWorkHistoryCredential('did:abt:agent', claimWithoutSpec);
    const hireWithoutSpec = withoutSpec.credentialSubject.hire as unknown as Record<string, unknown>;
    expect('specHash' in hireWithoutSpec).toBe(false);

    const withSpec = await adapter.issueWorkHistoryCredential('did:abt:agent', claim);
    const hireWithSpec = withSpec.credentialSubject.hire as unknown as Record<string, unknown>;
    expect('specHash' in hireWithSpec).toBe(true);
  });
});
