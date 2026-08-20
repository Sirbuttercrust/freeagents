// R-3, direction one (ENT-5): the agent's DID document carries a standard
// alsoKnownAs entry pointing at the agent's GitHub account. The operator
// authors that entry in their wallet tooling; this module is the pure
// decision of whether the document the identity adapter resolved actually
// points at the claimed account. No I/O: the document arrives as a plain
// field, so the rule can be lifted and verified without this service.

export function githubAccountUrl(handle: string): string {
  return `https://github.com/${handle}`;
}

// Total: any value in, one boolean out, never a throw. A half-built or
// malformed document is "no", so the API maps false to 409 without
// inspecting error messages, the same shape as delegationConsistent.
export function didDocumentPointsAtGithubAccount(
  alsoKnownAs: readonly string[] | null,
  handle: string,
): boolean {
  if (alsoKnownAs === null || !Array.isArray(alsoKnownAs)) return false;
  if (typeof handle !== 'string' || handle.trim().length === 0) return false;
  const target = githubAccountUrl(handle).toLowerCase();
  return alsoKnownAs.some((entry) => {
    if (typeof entry !== 'string') return false;
    // Operators and wallet tooling differ on the trailing slash and on
    // whitespace, and both name the same account.
    let candidate = entry.trim();
    if (candidate.endsWith('/')) candidate = candidate.slice(0, -1);
    return candidate.toLowerCase() === target;
  });
}
