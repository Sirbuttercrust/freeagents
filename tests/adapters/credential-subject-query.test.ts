// R-17: the profile route needs "every credential for this agent DID" plus
// the one fact evidenceTier needs that the VC document itself never carries
// (repositoryPublic, invariant 4: unverifiable work is never scored, so it
// travels beside the document exactly like subjectDid already does, never
// inside credentialSubject.hire). Both drivers are pinned here, the same
// split tests/adapters/storage.test.ts and
// tests/adapters/storage-memory.test.ts already use for other queries: the
// memory driver's own behaviour goes here, the Prisma driver's decisions go
// in tests/adapters/prisma.test.ts.
import { describe, expect, it } from 'vitest';
import { MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

function credential(id: string, subjectDid: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-01-03T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/target-repo',
        pullRequest: 'https://github.com/buyer/target-repo/pull/1',
        mergedAt: '2026-01-03T00:00:00.000Z',
        mergeCommit: 'deadbeef',
        signedBy: `${subjectDid}#key-1`,
        buyer: 'did:example:buyer',
        additions: 1,
        deletions: 1,
        filesChanged: 1,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

describe('MemoryCredentialRepository.listBySubjectDid', () => {
  it('returns every credential saved for that subject DID, in save order', async () => {
    const repo = new MemoryCredentialRepository();
    const agentDid = 'did:abt:zAgentQuery';
    await repo.save({ completedJobId: 'job-1', subjectDid: agentDid, document: credential('https://platform.example/v1/credentials/job-1', agentDid) });
    await repo.save({ completedJobId: 'job-2', subjectDid: agentDid, document: credential('https://platform.example/v1/credentials/job-2', agentDid) });

    const found = await repo.listBySubjectDid(agentDid);
    expect(found.map((row) => row.document.id)).toEqual([
      'https://platform.example/v1/credentials/job-1',
      'https://platform.example/v1/credentials/job-2',
    ]);
  });

  it("never returns another subject's credential", async () => {
    const repo = new MemoryCredentialRepository();
    await repo.save({ completedJobId: 'job-3', subjectDid: 'did:abt:zAgentOne', document: credential('https://platform.example/v1/credentials/job-3', 'did:abt:zAgentOne') });
    await repo.save({ completedJobId: 'job-4', subjectDid: 'did:abt:zAgentTwo', document: credential('https://platform.example/v1/credentials/job-4', 'did:abt:zAgentTwo') });

    const found = await repo.listBySubjectDid('did:abt:zAgentOne');
    expect(found).toHaveLength(1);
    expect(found[0]?.document.id).toBe('https://platform.example/v1/credentials/job-3');
  });

  it('an unknown subject DID returns an empty array, not null or a throw', async () => {
    const repo = new MemoryCredentialRepository();
    const found = await repo.listBySubjectDid('did:abt:zNobody');
    expect(found).toEqual([]);
  });

  it('repositoryPublic defaults to false when the caller omits it at save time', async () => {
    const repo = new MemoryCredentialRepository();
    const agentDid = 'did:abt:zAgentDefault';
    await repo.save({ completedJobId: 'job-5', subjectDid: agentDid, document: credential('https://platform.example/v1/credentials/job-5', agentDid) });

    const found = await repo.listBySubjectDid(agentDid);
    expect(found[0]?.repositoryPublic).toBe(false);
  });

  it('repositoryPublic is stored and read back honestly when the caller supplies true', async () => {
    const repo = new MemoryCredentialRepository();
    const agentDid = 'did:abt:zAgentPublic';
    await repo.save({
      completedJobId: 'job-6',
      subjectDid: agentDid,
      document: credential('https://platform.example/v1/credentials/job-6', agentDid),
      repositoryPublic: true,
    });

    const found = await repo.listBySubjectDid(agentDid);
    expect(found[0]?.repositoryPublic).toBe(true);
  });
});
