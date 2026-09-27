// GitHub reports a repository owner, a repo name, a user login and a
// commit sha in ITS OWN canonical case, regardless of the spelling a
// caller typed when the fact was first stored (POST /jobs's repository,
// account-proof's githubLogin, stage's stagedCommit). GitHub itself
// treats all four identifiers case-insensitively -- the same stance
// account-proof's own gist-owner check already takes. Comparing any of
// them with a bare !== refuses an honest, fully paid pull request forever
// whenever the stored spelling and GitHub's reported spelling merely
// differ in case. Every chain-identifier compare in the pull-request and
// merge routes, and in the staging adapter's commit-signer check, goes
// through this one function.
export function chainIdentifiersMatch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}
