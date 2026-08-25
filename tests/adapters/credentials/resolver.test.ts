// R-15, the serve-only adapter: what the app ships before R-13 wires the
// platform issuer in. Its honesty is the contract under test: the half it
// does not have throws the named capability error instead of returning
// undefined or a stubbed document, and the half it does have (resolution)
// comes back from the repository it was handed, by id or by full credential
// id, with the null arm mapping to the 404's domain error.
import { describe, expect, it } from 'vitest';

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
  specHash: 'sha256:spec',
  filesChanged: 1,
  repository: 'buyer/target-repo',
  signedBy: 'did:abt:agent#job-1',
  buyerDid: 'did:example:buyer',
};

const document: VerifiableCredential = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential', 'CompletedHireCredential'],
  issuer: 'did:abt:platform',
  credentialSubject: { ...claim, id: 'did:abt:agent' },
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
  it('verification still throws the named capability error (invariant 2 is external)', () => {
    const adapter = createCredentialsAdapter(
      { did: 'did:abt:platform', seed: new Uint8Array(32) },
      new MemoryCredentialRepository(),
    );

    expect(() => adapter.verifyCredential(document)).toThrowError(NotImplementedError);
  });
});
