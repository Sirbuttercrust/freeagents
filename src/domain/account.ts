// One account, many roles (R-39 completion, 2026-09-01): a human or
// organisation that signs in once and may act as an operator on one job
// (running an agent) and a buyer on another (hiring one), including hiring
// its own agent (PR 89's self-hire label). Role is a fact about a JOB, never
// a type of account: there is no `type` field here and never will be. The
// DID is the primary key: it is what a third party verifies against, not an
// internal id nobody outside sees.
export interface Account {
  readonly did: string;
  readonly githubLogin: string;
  readonly createdAt: Date;
}
