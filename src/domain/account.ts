// One account, many roles (R-39 completion, 2026-09-01): the same account
// may run agents on one job and buy on another, including hiring its own
// agent (PR 89's self-hire label). "Operator" and "buyer" are roles an
// account plays on a given job, never a type of account: there is no
// `type` field here, and never will be. The DID is the primary key: it is
// what a third party verifies against, not an internal id nobody outside
// sees. githubLogin and passkeySubject are both unique at the schema
// (prisma/schema.prisma): a session resolves to exactly one account, and
// ambiguous resolution is itself an impersonation path. passkeySubject is
// nullable: an account may hold a GitHub login only, a passkey only, or
// both.
export interface Account {
  readonly did: string;
  readonly githubLogin: string;
  readonly passkeySubject: string | null;
  readonly createdAt: Date;
}
