// An operator has built an agent and wants its record to be worth something
// (MISSION.md, "Who it is for"). The DID is the primary key: it is what a
// third party verifies against, not an internal id nobody outside sees.

export interface Operator {
  readonly did: string;
  readonly githubLogin: string;
  readonly createdAt: Date;
}
