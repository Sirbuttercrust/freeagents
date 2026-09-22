// AV1: the memory storage adapter's own avatarSpec column. Null by default
// (no change to any other field); PATCH/DELETE flows through
// setAvatarSpec, mirroring the existing setOperatorAddressEvm shape on
// AccountRepository (overwrite-or-clear, one method, null-on-unknown-DID).
import { describe, expect, it } from 'vitest';

import { MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';

const delegation: Delegation = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:avatar-spec-storage-test',
  type: ['VerifiableCredential', 'AgentDelegation'],
  issuer: 'did:abt:zOperatorKeyHash',
  issuanceDate: '2026-09-22T00:00:00.000Z',
  credentialSubject: { id: 'did:abt:zAgentKeyHash' },
  proof: {
    type: 'Ed25519Signature2020',
    created: '2026-09-22T00:00:00.000Z',
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

describe('MemoryAgentRepository, avatarSpec column (AV1)', () => {
  it('create() returns avatarSpec: null -- no override by default', async () => {
    const repo = new MemoryAgentRepository();
    const agent = await repo.create({
      did: 'did:abt:zAgentFreshAvatar',
      operatorDid: 'did:abt:zOperatorKeyHash',
      delegation,
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    expect(agent.avatarSpec).toBeNull();
  });

  it('setAvatarSpec stores an override and the row reads it back', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentAvatarSet';
    await register(repo, did);

    const updated = await repo.setAvatarSpec(did, { shape: 'triangle', face: 'mouth', colour: 'c7' });
    expect(updated?.avatarSpec).toEqual({ shape: 'triangle', face: 'mouth', colour: 'c7' });

    const stored = await repo.findByDid(did);
    expect(stored?.avatarSpec).toEqual({ shape: 'triangle', face: 'mouth', colour: 'c7' });
  });

  it('setAvatarSpec(did, null) clears the override back to the default', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentAvatarClear';
    await register(repo, did);
    await repo.setAvatarSpec(did, { shape: 'triangle', face: 'mouth', colour: 'c7' });

    const cleared = await repo.setAvatarSpec(did, null);
    expect(cleared?.avatarSpec).toBeNull();

    const stored = await repo.findByDid(did);
    expect(stored?.avatarSpec).toBeNull();
  });

  it('setAvatarSpec returns null for an unregistered DID, and writes nothing', async () => {
    const repo = new MemoryAgentRepository();
    const updated = await repo.setAvatarSpec('did:abt:zNobody', { shape: 'star', face: 'eyes', colour: 'c1' });
    expect(updated).toBeNull();
    expect(await repo.findByDid('did:abt:zNobody')).toBeNull();
  });

  it('setting the avatar override never touches any other field on the row', async () => {
    const repo = new MemoryAgentRepository();
    const did = 'did:abt:zAgentAvatarIsolated';
    await register(repo, did);
    const before = await repo.findByDid(did);

    const after = await repo.setAvatarSpec(did, { shape: 'ghost', face: 'eyes', colour: 'c3' });

    expect(after?.name).toBe(before?.name);
    expect(after?.skills).toEqual(before?.skills);
    expect(after?.operatorDid).toBe(before?.operatorDid);
    expect(after?.delegation).toEqual(before?.delegation);
    expect(after?.keyRotations).toEqual(before?.keyRotations);
  });
});
