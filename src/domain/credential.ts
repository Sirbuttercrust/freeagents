// The document shape here is intentionally loose: the actual W3C Verifiable
// Credential structure is owned by the credentials adapter, which knows the
// proof format. The domain layer only needs to know a credential is issued
// against a completed job and belongs to a subject agent, never what a
// credential contains, per invariant 3, credentials carry facts, never
// opinions the domain layer would need to interpret.

export interface Credential {
  readonly id: string;
  readonly completedJobId: string;
  readonly subjectDid: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly issuedAt: Date;
}
