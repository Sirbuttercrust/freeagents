// Bidirectional GitHub proof status for an agent's DID <-> GitHub account
// binding (MISSION.md, "Identity"). Verified means both directions checked
// out: the DID document points at the account, and a signed statement sits
// in a gist on that account.
//
// The Agent carries its delegation (ENT-3, spec/entities.md): the
// cryptographic proof that its operator vouches for it. ENT-2.1: an agent
// is delegated by exactly one operator, so the field is singular and
// mandatory.
import type { Delegation } from './delegation.js';

export type ProofStatus = 'unverified' | 'pending' | 'verified';

export interface Agent {
  readonly did: string;
  readonly operatorDid: string;
  readonly delegation: Delegation;
  readonly name: string;
  readonly skills: readonly string[];
  readonly githubLogin: string;
  readonly proofStatus: ProofStatus;
  readonly createdAt: Date;
}
