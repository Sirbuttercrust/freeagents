// Credentials capability (MISSION.md, "Credentials"): issue a work-history
// VC on merge, verify one, serve one. The claim shape follows invariant 2, a
// third party verifies it with an off-the-shelf W3C VC verifier and nothing
// else, so it carries only facts a merged pull request already proves.
//
// P5 adds signAttestation (design record, 2026-09-01): the platform
// signature over a machine-produced attestation (src/domain/attestation.ts),
// through the SAME Ed25519Signature2020 proof construction and the SAME
// platform key as issueWorkHistoryCredential -- never a second signing path.
//
// Sources, in order:
// - the six original fields: the merged pull request's own outcome facts
// - specHash: ENT-8 / D2, the confirmed spec hash ties the credential to what
//   was agreed and is recomputable from the criteria text alone; nullable
//   because a job may complete without a confirmed spec (R-35)
// - diffFiles, repository, signedBy, buyerDid: the draft spec's wire fields
//   (ENT-8) for where, by whom, and for whom the merge happened
// - briefHash: ENT-4, the hash of the buyer's own prose
//
// Wire choices recorded as assumptions (ASSUMPTIONS `credential_context`):
// the spec's v2 credentials context and `validFrom` (R-35 moves off the v1
// context and `issuanceDate` this adapter previously issued), and the
// `credentialSubject.hire` nesting the spec's wire shape defines (see
// `WorkHistoryHire` below). The `@vocab` object still applies under v2: it is
// a plain JSON-LD term default, not a v1-only construct.
import type { Attestation } from '../../domain/attestation.js';

export interface WorkHistoryClaim {
  readonly jobId: string;
  readonly pullRequestUrl: string;
  readonly mergeCommitSha: string;
  readonly mergedAt: string;
  readonly diffAdditions: number;
  readonly diffDeletions: number;
  // Renamed from filesChanged: the three diff-size inputs now read as one
  // family, and 'filesChanged' is reserved for the wire name it maps to.
  readonly diffFiles: number;
  // ENT-4: the hash of the buyer's own prose. The wire calls it 'brief'.
  readonly briefHash: string;
  // Nullable (R-35): a job may complete without a confirmed spec, and the
  // field is then omitted from the wire rather than sent as null.
  readonly specHash: string | null;
  // Spec wire: where the merge happened.
  readonly repository: string;
  // Spec wire: the agent verification method that signed the merge commit,
  // e.g. '<agentDid>#<fragment>'.
  readonly signedBy: string;
  // Spec wire ENT-8 'subject' side: who commissioned the work.
  readonly buyerDid: string;
}

// The 'hire' object exactly as spec/work-history-extension-v1.md:174-200
// defines it. Separate from WorkHistoryClaim because the wire names are the
// spec's and the claim names are this service's; jobId is deliberately not
// carried here (see the note on WorkHistoryClaim.jobId's wire absence in
// credentials.ts).
export interface WorkHistoryHire {
  readonly brief: string;
  readonly repository: string;
  readonly pullRequest: string;
  readonly mergedAt: string;
  readonly mergeCommit: string;
  readonly signedBy: string;
  readonly buyer: string;
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  // Present only when the job had a confirmed spec.
  readonly specHash?: string;
}

// Identity of the credential issuer ("the platform"). The DID suffix is
// derived from the seed, exactly like agent DIDs, so the proof's
// verification method binds back to the DID without any lookup in this
// service (invariant 2).
export interface CredentialsIssuer {
  readonly did: string; // did:abt:<suffix derived from the issuer key>
  readonly seed: Uint8Array; // 32-byte Ed25519 seed; key material, never persisted
}

export interface VerifiableCredential {
  readonly '@context': readonly (string | Readonly<Record<string, unknown>>)[];
  readonly id: string;
  readonly type: readonly string[];
  readonly issuer: string;
  readonly validFrom: string;
  readonly credentialSubject: {
    readonly id: string;
    readonly hire: WorkHistoryHire;
  };
  // Ed25519Signature2020, a registered proof type, never a vendor-specific
  // one (invariant 2).
  readonly proof: Readonly<Record<string, unknown>>;
}

// The signed attestation document (P5): the same VerifiableCredential
// envelope, carrying the Attestation verbatim under credentialSubject
// rather than a WorkHistoryHire. A distinct wire type from
// VerifiableCredential above because the subject shape differs (no
// buyer/agent DID pair to name as `id` in the usual sense -- see
// signAttestation's own header comment in credentials.ts for the subject
// id this uses instead) and callers must not accidentally treat one as
// the other.
export interface SignedAttestation {
  readonly '@context': readonly (string | Readonly<Record<string, unknown>>)[];
  readonly id: string;
  readonly type: readonly string[];
  readonly issuer: string;
  readonly validFrom: string;
  readonly credentialSubject: {
    readonly id: string;
    readonly attestation: Attestation;
  };
  readonly proof: Readonly<Record<string, unknown>>;
}

export interface CredentialsAdapter {
  issueWorkHistoryCredential(subjectDid: string, claim: WorkHistoryClaim): Promise<VerifiableCredential>;
  verifyCredential(credential: VerifiableCredential): Promise<boolean>;
  getCredential(credentialId: string): Promise<VerifiableCredential>;
  // P5: sign the canonical serialization of an attestation (see
  // src/domain/attestation.ts's serializeAttestation) with the platform
  // key, through the same Ed25519Signature2020 construction
  // issueWorkHistoryCredential already uses. The id is a stable, resolvable
  // handle keyed on the staged commit (ENT-8's stance, restated): a
  // stranger can recompute it from the attestation's own stagedCommit
  // field without calling this service.
  signAttestation(attestation: Attestation): Promise<SignedAttestation>;
}
