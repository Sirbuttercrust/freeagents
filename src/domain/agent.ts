// Bidirectional GitHub proof status for an agent's DID <-> GitHub account
// binding (MISSION.md, "Identity"). Verified means both directions checked
// out: the DID document points at the account, and a signed statement sits
// in a gist on that account.
export type ProofStatus = 'unverified' | 'pending' | 'verified';

export interface Agent {
  readonly did: string;
  readonly operatorDid: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly githubLogin: string;
  readonly proofStatus: ProofStatus;
  readonly createdAt: Date;
}
