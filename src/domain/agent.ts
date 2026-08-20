// An operator has built an agent and wants its identity to be worth
// something (ENT-2): the agent DID, plus the delegation proof that binds it
// to the operator DID (ENT-3). The agent DID is the primary key: it is what
// a third party verifies against, not an internal id.

// ENT-3, in the shape the operator's wallet produced it. The stored object
// is the FULL credential, not a projection of it: drop the proof signature
// and the stored copy stops verifying off-platform (ENT-3.1). This is a W3C
// Verifiable Credential with Ed25519Signature2020 proof (MISSION.md invariant 2).
export interface Delegation {
  readonly '@context': readonly (string | Record<string, unknown>)[];
  readonly id: string;
  readonly type: readonly string[];
  readonly issuer: string;
  readonly issuanceDate: string;
  readonly credentialSubject: { readonly id: string; readonly [key: string]: unknown };
  readonly proof: {
    readonly type: string;
    readonly created: string;
    readonly verificationMethod: string;
    readonly proofPurpose: string;
    readonly proofValue: string;
  };
}

// The one type tag this service understands on a delegation credential.
// Product value, recorded in the run report: the spec does not name it.
export const DELEGATION_TYPE = 'AgentDelegation';

// Wallet tooling signs with the short-form key hash (z...) while the
// registry records the full DID (did:abt:z...). Both name the same key, and
// a credential's issuer or subject may arrive in either form, so every
// comparison in this file goes through this reconciliation. Total.
export function didSuffix(did: string): string {
  return did.startsWith('did:abt:') ? did.slice('did:abt:'.length) : did;
}

export type ProofStatus = 'unverified' | 'pending' | 'verified';

export interface Agent {
  readonly did: string;
  readonly operatorDid: string;
  readonly delegation: Delegation;
  readonly name: string;
  readonly skills: readonly string[];
  readonly githubLogin: string | null;
  readonly proofStatus: ProofStatus;
  readonly createdAt: Date;
}

// The structural half of "the delegation proof verifies" (R-2 accept). The
// cryptographic half runs in the identity adapter, because it needs the
// cryptographic machinery; this is the half that must never throw on a
// half-built or stored record, so an agent can be re-checked (ENT-2.4)
// without a try/catch at the call site. Total: any value in, one boolean out.
export function delegationConsistent(
  agent: Pick<Agent, 'did' | 'operatorDid' | 'delegation'>,
): boolean {
  const did = agent.did;
  const operatorDid = agent.operatorDid;
  const delegation = agent.delegation;
  if (typeof did !== 'string' || did.length === 0) return false;
  if (typeof operatorDid !== 'string' || operatorDid.length === 0) return false;
  if (typeof delegation !== 'object' || delegation === null) return false;
  if (!Array.isArray(delegation.type) || !delegation.type.includes(DELEGATION_TYPE)) {
    return false;
  }
  if (typeof delegation.issuer !== 'string' || delegation.issuer.length === 0) return false;
  if (didSuffix(delegation.issuer) !== didSuffix(operatorDid)) return false;
  if (typeof delegation.credentialSubject?.id !== 'string' || delegation.credentialSubject.id.length === 0) {
    return false;
  }
  if (didSuffix(delegation.credentialSubject.id) !== didSuffix(did)) return false;
  if (typeof delegation.proof?.type !== 'string' || delegation.proof.type !== 'Ed25519Signature2020') {
    return false;
  }
  if (typeof delegation.proof?.proofValue !== 'string' || delegation.proof.proofValue.length === 0) {
    return false;
  }
  if (typeof delegation.issuanceDate !== 'string' || Number.isNaN(Date.parse(delegation.issuanceDate))) {
    return false;
  }
  return true;
}
