// Credentials capability (MISSION.md, "Credentials"): issue a work-history
// VC on merge, verify one, serve one. The claim shape follows invariant 2, a
// third party verifies it with an off-the-shelf W3C VC verifier and nothing
// else, so it carries only facts a merged pull request already proves.
//
// Sources, in order:
// - the six original fields: the merged pull request's own outcome facts
// - specHash: ENT-8 / D2, the confirmed spec hash ties the credential to what
//   was agreed and is recomputable from the criteria text alone
// - filesChanged, repository, signedBy, buyerDid: the draft spec's wire
//   fields (ENT-8) for where, by whom, and for whom the merge happened
//
// Wire choices recorded as assumptions (ASSUMPTIONS A1, A2): the v1
// credentials context with issuanceDate (not the draft spec's v2 context /
// validFrom, matching the credential we already issue and prove) and the
// flat subject shape this interface types (the draft's `hire` nesting is a
// draft, not a wire we ship).

export interface WorkHistoryClaim {
  readonly jobId: string;
  readonly pullRequestUrl: string;
  readonly mergeCommitSha: string;
  readonly mergedAt: string;
  readonly diffAdditions: number;
  readonly diffDeletions: number;
  // ENT-8: the confirmed spec hash (D2).
  readonly specHash: string;
  // ENT-8: diffSize.files from the merged pull request.
  readonly filesChanged: number;
  // Spec wire: where the merge happened.
  readonly repository: string;
  // Spec wire: the agent verification method that signed the merge commit,
  // e.g. '<agentDid>#<fragment>'.
  readonly signedBy: string;
  // Spec wire ENT-8 'subject' side: who commissioned the work.
  readonly buyerDid: string;
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
  readonly '@context': readonly string[];
  readonly type: readonly string[];
  readonly issuer: string;
  readonly credentialSubject: WorkHistoryClaim & { readonly id: string };
  // Ed25519Signature2020, a registered proof type, never a vendor-specific
  // one (invariant 2).
  readonly proof: Readonly<Record<string, unknown>>;
}

export interface CredentialsAdapter {
  issueWorkHistoryCredential(subjectDid: string, claim: WorkHistoryClaim): Promise<VerifiableCredential>;
  verifyCredential(credential: VerifiableCredential): Promise<boolean>;
  getCredential(credentialId: string): Promise<VerifiableCredential>;
}
