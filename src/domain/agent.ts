// An operator has built an agent and wants its identity to be worth
// something (ENT-2): the agent DID, plus the delegation proof that binds it
// to the operator DID (ENT-3). The agent DID is the primary key: it is what
// a third party verifies against, not an internal id.

// ENT-3, in the shape the operator's wallet produced it. The stored object
// is the FULL credential, not a projection of it: drop the issuer's public
// key or the signature and the stored copy stops verifying off-platform
// (ENT-3.1). The field names below mirror the vendor credential on purpose,
// because the bytes that verify are the bytes we store; describing the shape
// here is what keeps the domain free of the vendor import (CLAUDE.md).
export interface Delegation {
  readonly type: readonly string[];
  readonly issuer: { readonly id: string; readonly pk: string };
  readonly credentialSubject: { readonly id: string };
  readonly proof: { readonly jws: string };
  readonly issuanceDate: string;
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
// vendor's key machinery; this is the half that must never throw on a
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
  if (typeof delegation.issuer?.id !== 'string' || delegation.issuer.id.length === 0) return false;
  if (typeof delegation.issuer?.pk !== 'string' || delegation.issuer.pk.length === 0) return false;
  if (didSuffix(delegation.issuer.id) !== didSuffix(operatorDid)) return false;
  if (typeof delegation.credentialSubject?.id !== 'string' || delegation.credentialSubject.id.length === 0) {
    return false;
  }
  if (didSuffix(delegation.credentialSubject.id) !== didSuffix(did)) return false;
  if (typeof delegation.proof?.jws !== 'string' || delegation.proof.jws.length === 0) return false;
  if (typeof delegation.issuanceDate !== 'string' || Number.isNaN(Date.parse(delegation.issuanceDate))) {
    return false;
  }
  return true;
}
