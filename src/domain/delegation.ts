// Delegation: cryptographic proof that an operator vouches for an agent
// (ENT-3, spec/entities.md). ENT-3.1: verifiable without calling FreeAgents.
// MISSION invariant 2: a third party can verify the result without calling
// this service. The signature in `proof` was signed by the operator's key;
// checking that signature is the adapter's job (invariant 9: the domain holds
// no vendor and no database handle). The domain decides liveness from facts
// alone. ENT-3.2: revoking a delegation does not invalidate credentials
// issued before the revocation; it stops NEW work being attributed.
// `isLiveFor` is exactly that attribution check.

export interface Delegation {
  readonly operator: string; // DID, the parent (ENT-1)
  readonly subject: string; // DID, the agent (ENT-2)
  readonly proof: string; // signature signed by the operator key, opaque to the domain
  readonly issuedAt: Date;
  readonly revokedAt: Date | null; // null while live
}

// Total: never throws. A delegation covers its named subject only while it
// is live. Once revoked, no new work is attributed to it, but what was
// already issued stands (ENT-3.2; the credential half of that rule belongs
// to ENT-8 and is FOLLOWUP work, not this file's).
export function isLiveFor(delegation: Delegation, subjectDid: string): boolean {
  return delegation.revokedAt === null && delegation.subject === subjectDid;
}
