// R-17 (ENT-8, ENT-2.4): assembles an agent's work record as three
// separately labelled tiers, never a combined score. This is assembly over
// src/domain/evidence.ts's tier decision, not a second tier function: the
// tier for every credential this platform issued is computed here at read
// time from the one fact evidenceTier needs beyond what a merge already
// proves (repositoryPublic), never read from a stored tier column. The
// never-blended shape mirrors src/domain/liveness.ts's selfReported field:
// each tier is its own array, and nothing here ever sums, averages, or
// sorts by more than one of them.
import { evidenceTier } from './evidence.js';

// One credential's evidence, as read off the stored record: every field
// but repositoryPublic comes straight from the issued VerifiableCredential
// (credentialId is the resolvable id R-40 emits, never hand-built), and
// repositoryPublic is the one fact ENT-8.3 forbids inside the signed
// document, carried beside it instead.
export interface CredentialEvidence {
  readonly credentialId: string;
  readonly repository: string;
  readonly pullRequest: string;
  readonly mergedAt: string;
  readonly mergeCommit: string;
  readonly buyerDid: string;
  readonly repositoryPublic: boolean;
}

// The verified-hire tier's public shape: exactly what a buyer can already
// check against the pull request, plus the resolvable credential id.
export interface VerifiedHireItem {
  readonly credentialId: string;
  readonly repository: string;
  readonly pullRequest: string;
  readonly mergedAt: string;
  readonly mergeCommit: string;
  readonly buyerDid: string;
}

// Three separate arrays, one per tier. No field here may be derived from
// more than one of them: that is the anchor this module exists to hold.
export interface AgentWorkRecord {
  readonly verifiedHires: readonly VerifiedHireItem[];
  readonly verifiedPriorWork: readonly VerifiedHireItem[];
  readonly portfolio: readonly VerifiedHireItem[];
}

function toItem(credential: CredentialEvidence): VerifiedHireItem {
  return {
    credentialId: credential.credentialId,
    repository: credential.repository,
    pullRequest: credential.pullRequest,
    mergedAt: credential.mergedAt,
    mergeCommit: credential.mergeCommit,
    buyerDid: credential.buyerDid,
  };
}

// Every credential this service issued came from completeJob's merge route
// (ENT-8.2, issued only on merge), so platformBrokered and pullRequestMerged
// are true for all of them; repositoryPublic is the only fact that varies
// per row, read off the stored record rather than assumed (PR 70's rejected
// finding). No credential in this codebase carries a signed-commit,
// no-brief shape yet (that path is R-11's prior-work item, ENT-11, not yet
// wired to this route), so verifiedPriorWork and portfolio are empty until
// that source exists; the tiers themselves stay separate arrays regardless.
export function agentWorkRecord(credentials: readonly CredentialEvidence[]): AgentWorkRecord {
  const verifiedHires: VerifiedHireItem[] = [];
  const portfolio: VerifiedHireItem[] = [];
  for (const credential of credentials) {
    const tier = evidenceTier({
      platformBrokered: true,
      pullRequestMerged: true,
      signedCommit: false,
      repositoryPublic: credential.repositoryPublic,
      ownerSubmitted: false,
    });
    if (tier === 'verified-hire') {
      verifiedHires.push(toItem(credential));
    } else {
      // A platform-brokered merge into a private repository is not a
      // verified hire (invariant 4): it demotes to portfolio rather than
      // vanishing, the same way ENT-11.4 demotes a prior-work item whose
      // proof no longer stands.
      portfolio.push(toItem(credential));
    }
  }
  return { verifiedHires, verifiedPriorWork: [], portfolio };
}
