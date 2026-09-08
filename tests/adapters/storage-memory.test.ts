// R-3 direction one: MemoryAgentRepository.updateGithubBinding returns null
// for an unregistered DID (the API maps that to 404 without a second lookup)
// and replaces the stored binding when a later check passes for a different
// handle. No test had executed either branch.
import { describe, expect, it } from 'vitest';
import { MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { Job } from '../../src/domain/job.js';

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

// R-20: browse needs every listed agent. listAll is oldest-first (insertion
// order, the same convention MemoryCredentialRepository.listBySubjectDid
// already uses), and empty for a store with none, never null: a zero
// listing renders as a zero, not as an absence (ENT-2.4, D1).
describe('MemoryAgentRepository.listAll', () => {
  it('is empty for a store with no agents', async () => {
    const repo = new MemoryAgentRepository();
    expect(await repo.listAll()).toEqual([]);
  });

  it('returns every registered agent, oldest first', async () => {
    const repo = new MemoryAgentRepository();
    await register(repo, 'did:abt:zAgentFirst');
    await register(repo, 'did:abt:zAgentSecond');

    const rows = await repo.listAll();
    expect(rows.map((r) => r.did)).toEqual(['did:abt:zAgentFirst', 'did:abt:zAgentSecond']);
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

// P7: the operator's listing filters, both null by default when the
// caller omits them, matching floorPriceUsd's own stance.
describe('MemoryAgentRepository: buyer conduct filters', () => {
  it('create() defaults both thresholds to null when omitted', async () => {
    const repo = new MemoryAgentRepository();
    const agent = await repo.create({
      did: 'did:abt:zAgentNoThresholds',
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    expect(agent.minBuyerMerges).toBeNull();
    expect(agent.maxWalkedAfterConfirm).toBeNull();
  });

  it('create() stores whatever thresholds the caller sets, and round-trips them', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentWithThresholds';
    const agent = await repo.create({
      did,
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
      minBuyerMerges: 2,
      maxWalkedAfterConfirm: 0,
    });
    expect(agent.minBuyerMerges).toBe(2);
    expect(agent.maxWalkedAfterConfirm).toBe(0);
    const stored = await repo.findByDid(did);
    expect(stored?.minBuyerMerges).toBe(2);
    expect(stored?.maxWalkedAfterConfirm).toBe(0);
  });
});

// P7: every job for one buyer DID, in any status. Empty for a buyer with
// none, never null (the same "zero renders as zero" stance
// findCompletedByAgent already takes).
function jobFixture(): Job {
  return {
    id: 'job_x',
    buyerDid: 'did:example:buyer',
    agentDid: 'did:example:agent',
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug on the checkout page',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'draft',
    criteria: [],
    priceUsd: null,
    rail: null,
    priceAcceptedByBuyer: false,
    priceAcceptedByAgent: false,
    depositPercent: 25,
    redoAllowance: 1,
    redoUsedCount: 0,
    redoRequestedCriterionIndex: null,
    redoRequestedAt: null,
    redoRefusedAt: null,
    stagedLapseExtensionDays: 0,
    deliveryWindowDays: null,
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    stagedAt: null,
    stagedCommit: null,
    stagingRepo: null,
    baseCommit: null,
    stagingRepoDeleteAfter: null,
    citedCloseCriterionIndex: null,
    citedCloseReasonText: null,
    citedCloseAuthorDid: null,
    citedCloseAt: null,
    deemedCompletedAt: null,
  };
}

describe('MemoryJobRepository.findByBuyerDid', () => {
  it('is empty for a buyer with no jobs', async () => {
    const repo = new MemoryJobRepository();
    expect(await repo.findByBuyerDid('did:abt:zNoJobs')).toEqual([]);
  });

  it('returns every job for the buyer, regardless of status, and none for another buyer', async () => {
    const repo = new MemoryJobRepository();
    const buyer = 'did:abt:zBuyerConduct';
    const other = 'did:abt:zOtherBuyer';
    await repo.create({ ...jobFixture(), id: 'job_a', buyerDid: buyer, status: 'draft' });
    await repo.create({ ...jobFixture(), id: 'job_b', buyerDid: buyer, status: 'withdrawn' });
    await repo.create({ ...jobFixture(), id: 'job_c', buyerDid: other, status: 'completed' });

    const rows = await repo.findByBuyerDid(buyer);
    expect(rows.map((r) => r.id).sort()).toEqual(['job_a', 'job_b']);
  });
});

// P8p: every job offered to one agent DID, in any status. Empty for an
// agent with none, never null (the same "zero renders as zero" stance
// findByBuyerDid already takes).
describe('MemoryJobRepository.findByAgentDid', () => {
  it('is empty for an agent with no jobs', async () => {
    const repo = new MemoryJobRepository();
    expect(await repo.findByAgentDid('did:abt:zNoOffers')).toEqual([]);
  });

  it('returns every job for the agent, regardless of status, and none for another agent', async () => {
    const repo = new MemoryJobRepository();
    const agent = 'did:abt:zIncomingAgent';
    const other = 'did:abt:zOtherAgent';
    await repo.create({ ...jobFixture(), id: 'job_a', agentDid: agent, status: 'draft' });
    await repo.create({ ...jobFixture(), id: 'job_b', agentDid: agent, status: 'proposed' });
    // QA D2 (review round 1): the prior test never seeded a status
    // outside draft/proposed for the TARGET agent, so "every job ... in
    // any status" (done-means 3) was asserted by the test's title
    // alone. job_d pins a confirmed job for the same agent: a driver
    // that silently narrows to notReal statuses must redden here.
    await repo.create({ ...jobFixture(), id: 'job_d', agentDid: agent, status: 'confirmed' });
    await repo.create({ ...jobFixture(), id: 'job_c', agentDid: other, status: 'completed' });

    const rows = await repo.findByAgentDid(agent);
    expect(rows.map((r) => r.id).sort()).toEqual(['job_a', 'job_b', 'job_d']);
  });
});
