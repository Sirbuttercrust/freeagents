// R-3 direction one: MemoryAgentRepository.updateGithubBinding returns null
// for an unregistered DID (the API maps that to 404 without a second lookup)
// and replaces the stored binding when a later check passes for a different
// handle. No test had executed either branch.
import { describe, expect, it } from 'vitest';
import { MemoryAgentRepository, MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

// The stored delegation only needs its shape: create() does not re-verify.
const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:storage-memory-test',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: 'did:abt:zOperatorKeyHash',
  issuanceDate: '2026-08-20T05:00:00.000Z',
  credentialSubject: { id: 'did:abt:zAgentKeyHash' },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-08-20T05:00:00.000Z',
    verificationMethod: 'did:abt:zOperatorKeyHash#zOperatorKeyHash',
    proofPurpose: 'assertionMethod',
    proofValue: 'zMockProofValue',
  },
};

async function register(repo: MemoryAgentRepository, did: string): Promise<void> {
  await repo.create({
    did,
    operatorDid: 'did:abt:zOperatorKeyHash',
    delegation,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });
}

describe('MemoryAgentRepository.recordKeyRotation', () => {
  it('returns null for an unregistered DID', async () => {
    const repo = new MemoryAgentRepository();
    const rotated = await repo.recordKeyRotation('did:abt:zNobody', {
      fromKey: 'did:abt:zOldKey#zOldFingerprint',
      toKey: 'did:abt:zNewKey#zNewFingerprint',
    });
    expect(rotated).toBeNull();
  });

  it('appends: two rotations are both present, in order, first not replaced', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentRotations';
    await register(repo, did);

    const first = await repo.recordKeyRotation(did, {
      fromKey: 'did:abt:zOldKey#zOldFingerprint',
      toKey: 'did:abt:zNewKey#zNewFingerprint',
    });
    expect(first?.keyRotations).toHaveLength(1);
    expect(first?.keyRotations[0]?.fromKey).toBe('did:abt:zOldKey#zOldFingerprint');

    const second = await repo.recordKeyRotation(did, {
      fromKey: 'did:abt:zNewKey#zNewFingerprint',
      toKey: 'did:abt:zNewerKey#zNewerFingerprint',
    });
    expect(second?.keyRotations).toHaveLength(2);
    // The first record survives the second: replacing it would silently
    // orphan the credentials signed by the older key (ENT-8.4).
    expect(second?.keyRotations[0]?.fromKey).toBe('did:abt:zOldKey#zOldFingerprint');
    expect(second?.keyRotations[0]?.toKey).toBe('did:abt:zNewKey#zNewFingerprint');
    expect(second?.keyRotations[1]?.fromKey).toBe('did:abt:zNewKey#zNewFingerprint');
    expect(second?.keyRotations[1]?.toKey).toBe('did:abt:zNewerKey#zNewerFingerprint');

    // The append survives the round trip.
    const stored = await repo.findByDid(did);
    expect(stored?.keyRotations).toHaveLength(2);
    expect(stored?.keyRotations[0]?.fromKey).toBe('did:abt:zOldKey#zOldFingerprint');
  });

  it('stamps the rotation with a driver-set, parseable rotatedAt', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentStamped';
    await register(repo, did);

    const rotated = await repo.recordKeyRotation(did, {
      fromKey: 'did:abt:zOldKey#zOldFingerprint',
      toKey: 'did:abt:zNewKey#zNewFingerprint',
    });
    const rotatedAt = rotated?.keyRotations[0]?.rotatedAt;
    expect(rotatedAt).toBeInstanceOf(Date);
    // The driver stamps it; the test cannot know the value, only that it
    // parses.
    expect(Number.isNaN((rotatedAt as Date).getTime())).toBe(false);
  });

  it('create() returns keyRotations: []', async () => {
    const repo = new MemoryAgentRepository();
    const agent = await repo.create({
      did: 'did:abt:zAgentFresh',
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    expect(agent.keyRotations).toEqual([]);
  });
});

describe('MemoryAgentRepository.updateGithubBinding', () => {
  it('returns null for an unregistered DID', async () => {
    const repo = new MemoryAgentRepository();
    const updated = await repo.updateGithubBinding('did:abt:zNobody', {
      handle: 'scout-agent',
      status: 'pending',
    });
    expect(updated).toBeNull();
  });

  it('records the binding, and a later check replaces it', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentMemory';
    await register(repo, did);

    const first = await repo.updateGithubBinding(did, { handle: 'scout-agent', status: 'pending' });
    expect(first).not.toBeNull();
    expect(first?.githubLogin).toBe('scout-agent');
    expect(first?.proofStatus).toBe('pending');

    // The live DID document is the source of truth: a later successful check
    // for a different handle must replace, not accumulate, the binding.
    const second = await repo.updateGithubBinding(did, {
      handle: 'scout-agent-2',
      status: 'verified',
    });
    expect(second?.githubLogin).toBe('scout-agent-2');
    expect(second?.proofStatus).toBe('verified');

    // The replacement survives the round trip.
    const stored = await repo.findByDid(did);
    expect(stored?.githubLogin).toBe('scout-agent-2');
    expect(stored?.proofStatus).toBe('verified');
  });
});

// R-17: the profile route needs every credential for one agent DID. The rows
// map used to hold bare documents, keyed only by completedJobId, with no
// subject to filter on; this suite pins the row-type change that made the
// query possible and the regression it could cause in findByDocumentId.
function credentialFixture(overrides: Partial<VerifiableCredential> = {}): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:zPlatformKeyHash',
    credentialSubject: {
      id: 'did:abt:zAgentKeyHash',
      jobId: 'job_1',
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
      mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
      mergedAt: '2026-01-03T00:00:00.000Z',
      diffAdditions: 1,
      diffDeletions: 1,
      specHash: 'sha256:spec',
      filesChanged: 1,
      repository: 'buyer/target-repo',
      signedBy: 'did:abt:zAgentKeyHash#job_1',
      buyerDid: 'did:abt:zBuyerKeyHash',
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
    ...overrides,
  } as VerifiableCredential;
}

describe('MemoryCredentialRepository.listBySubjectDid', () => {
  it('returns an empty array for a DID with no credentials, never null', async () => {
    const repo = new MemoryCredentialRepository();
    const rows = await repo.listBySubjectDid('did:abt:zNobody');
    expect(rows).toEqual([]);
  });

  it('returns only the requested subject\'s credentials when two subjects have credentials stored', async () => {
    const repo = new MemoryCredentialRepository();
    await repo.save({
      completedJobId: 'job_1',
      subjectDid: 'did:abt:zAgentA',
      document: credentialFixture(),
    });
    await repo.save({
      completedJobId: 'job_2',
      subjectDid: 'did:abt:zAgentB',
      document: credentialFixture(),
    });

    const rows = await repo.listBySubjectDid('did:abt:zAgentA');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completedJobId).toBe('job_1');
  });

  it('returns newest first', async () => {
    const repo = new MemoryCredentialRepository();
    await repo.save({
      completedJobId: 'job_1',
      subjectDid: 'did:abt:zAgentA',
      document: credentialFixture(),
    });
    await repo.save({
      completedJobId: 'job_2',
      subjectDid: 'did:abt:zAgentA',
      document: credentialFixture(),
    });

    const rows = await repo.listBySubjectDid('did:abt:zAgentA');
    expect(rows.map((row) => row.completedJobId)).toEqual(['job_2', 'job_1']);
  });

  it("each row's completedJobId is the lookup key the credential resolves under", async () => {
    const repo = new MemoryCredentialRepository();
    await repo.save({
      completedJobId: 'https://platform.example/v1/credentials/job_1',
      subjectDid: 'did:abt:zAgentA',
      document: credentialFixture(),
    });

    const rows = await repo.listBySubjectDid('did:abt:zAgentA');
    expect(rows[0]?.completedJobId).toBe('job_1');
    const found = await repo.findByDocumentId(`/v1/credentials/${rows[0]?.completedJobId}`);
    expect(found).not.toBeNull();
  });

  it('findByDocumentId still returns the same verbatim document after the row type change', async () => {
    const repo = new MemoryCredentialRepository();
    const document = credentialFixture();
    await repo.save({
      completedJobId: 'job_1',
      subjectDid: 'did:abt:zAgentA',
      document,
    });

    const found = await repo.findByDocumentId('job_1');
    expect(found).toEqual(document);
  });
});
