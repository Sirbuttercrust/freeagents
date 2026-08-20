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
