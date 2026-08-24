// ENT-8.4: a credential must verify against the key that signed it even
// after the agent has rotated. The rotation record is the link: it names
// the superseded key and when it was superseded, so a third party can
// resolve the old key from the agent's public record without calling this
// service. Keys are public identifiers in DID fragment form, the same
// shape as delegation.proof.verificationMethod; private material never
// appears in a record.

export interface KeyRotation {
  readonly fromKey: string;
  readonly toKey: string;
  readonly rotatedAt: Date;
}

// The structural half of "this rotation record is well formed" (R-29).
// Total: any value in, one boolean out, never throws, so a stored record
// can be re-checked without a try/catch at the call site (the stance
// delegationConsistent takes in agent.ts). fromKey === toKey is accepted
// here: equality is a semantic error the API rejects in R-30, not a shape
// error.
export function rotationWellFormed(rotation: KeyRotation): boolean {
  if (typeof rotation !== 'object' || rotation === null) return false;
  const { fromKey, toKey, rotatedAt } = rotation as {
    fromKey?: unknown;
    toKey?: unknown;
    rotatedAt?: unknown;
  };
  if (typeof fromKey !== 'string' || fromKey.length === 0 || !fromKey.includes('#')) {
    return false;
  }
  if (typeof toKey !== 'string' || toKey.length === 0 || !toKey.includes('#')) {
    return false;
  }
  if (rotatedAt instanceof Date) return !Number.isNaN(rotatedAt.getTime());
  if (typeof rotatedAt === 'string') return !Number.isNaN(Date.parse(rotatedAt));
  return false;
}

// The semantic half (R-30): a rotation supersedes a key with a different
// one. fromKey === toKey is a no-op the API rejects; the rule lives here
// rather than in the handler because it states what a rotation means, not
// what the HTTP surface accepts, and the handler delegates to it the way
// POST /jobs delegates brief emptiness to createJob.
export function rotationIsIdentity(fromKey: string, toKey: string): boolean {
  return fromKey === toKey;
}
