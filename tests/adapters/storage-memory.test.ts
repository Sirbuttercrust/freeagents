// R-3 direction one: MemoryAgentRepository.updateGithubBinding returns null
// for an unregistered DID (the API maps that to 404 without a second lookup)
// and replaces the stored binding when a later check passes for a different
// handle. No test had executed either branch.
import { describe, expect, it } from 'vitest';
import { MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

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

describe('MemoryAgentRepository.reportKeyCompromise', () => {
  it('returns null for an unregistered DID, called directly against the repository (the route 404s first)', async () => {
    const repo = new MemoryAgentRepository();
    const windows = await repo.reportKeyCompromise('did:abt:zNobody', {
      key: 'did:abt:zNobody#zK',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-10T00:00:00.000Z'),
    });
    expect(windows).toBeNull();
  });

  it('appends: two reports are both present, in order, first not replaced', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentCompromiseReports';
    await register(repo, did);

    const first = await repo.reportKeyCompromise(did, {
      key: `${did}#zFirst`,
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-05T00:00:00.000Z'),
    });
    expect(first).toHaveLength(1);
    expect(first?.[0]?.key).toBe(`${did}#zFirst`);

    const second = await repo.reportKeyCompromise(did, {
      key: `${did}#zSecond`,
      from: new Date('2026-08-06T00:00:00.000Z'),
      to: new Date('2026-08-09T00:00:00.000Z'),
    });
    expect(second).toHaveLength(2);
    expect(second?.[0]?.key).toBe(`${did}#zFirst`);
    expect(second?.[1]?.key).toBe(`${did}#zSecond`);
  });

  it('stamps the report with a driver-set, parseable reportedAt', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentCompromiseStamped';
    await register(repo, did);

    const windows = await repo.reportKeyCompromise(did, {
      key: `${did}#zK`,
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-10T00:00:00.000Z'),
    });
    const reportedAt = windows?.[0]?.reportedAt;
    expect(reportedAt).toBeInstanceOf(Date);
    expect(Number.isNaN((reportedAt as Date).getTime())).toBe(false);
  });
});

describe('MemoryAgentRepository.listCompromiseWindows', () => {
  it('returns null for an unregistered DID', async () => {
    const repo = new MemoryAgentRepository();
    const windows = await repo.listCompromiseWindows('did:abt:zNobody');
    expect(windows).toBeNull();
  });

  it('returns [] for a registered agent that has never reported', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentNeverReported';
    await register(repo, did);
    expect(await repo.listCompromiseWindows(did)).toEqual([]);
  });

  it('reflects a report made through reportKeyCompromise on the same DID', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentListAfterReport';
    await register(repo, did);
    await repo.reportKeyCompromise(did, {
      key: `${did}#zK`,
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-10T00:00:00.000Z'),
    });
    const windows = await repo.listCompromiseWindows(did);
    expect(windows).toHaveLength(1);
    expect(windows?.[0]?.key).toBe(`${did}#zK`);
  });
});
