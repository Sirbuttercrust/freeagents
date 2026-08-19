// Credentials capability (MISSION.md, "Credentials"): issue a work-history
// VC on merge, verify one, serve one. The claim shape follows invariant 2, a
// third party verifies it with an off-the-shelf W3C VC verifier and nothing
// else, so it carries only facts a merged pull request already proves.

export interface WorkHistoryClaim {
  readonly jobId: string;
  readonly pullRequestUrl: string;
  readonly mergeCommitSha: string;
  readonly mergedAt: string;
  readonly diffAdditions: number;
  readonly diffDeletions: number;
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
