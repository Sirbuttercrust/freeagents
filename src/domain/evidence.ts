// Evidence tier for an agent's profile (MISSION.md invariants 4 and 5: a
// buyer can verify every claim without calling this service, and the profile
// is the public face; ENT-11.1: the tier is computed at read time, never
// stored as a field somebody can set). The tier labels work a third party can
// inspect on their own: a merged pull request on a job that ran through the
// platform, or a signed commit in a public repository. Everything else is a
// claim the owner submitted, and it says so.

export type EvidenceTier = 'verified-hire' | 'verified-prior-work' | 'portfolio';

export interface EvidenceFacts {
  readonly platformBrokered: boolean; // the job ran through the platform (a brief is on file)
  readonly pullRequestMerged: boolean; // the platform's pull request merged
  readonly signedCommit: boolean; // a commit signed by the account's key
  readonly repositoryPublic: boolean; // a third party can inspect the repository
  readonly ownerSubmitted: boolean; // the operator submitted a link or screenshot
}

// Precedence, first match wins. Both verified tiers require repositoryPublic:
// work a third party cannot inspect is never verified, no matter what else is
// true. ownerSubmitted documents the portfolio tier's provenance; it is read
// but it never promotes, because a link or screenshot is a claim, not a fact.
export function evidenceTier(facts: EvidenceFacts): EvidenceTier {
  if (facts.platformBrokered && facts.pullRequestMerged && facts.repositoryPublic) {
    return 'verified-hire';
  }
  if (facts.signedCommit && facts.repositoryPublic && !facts.platformBrokered) {
    return 'verified-prior-work';
  }
  return 'portfolio';
}
