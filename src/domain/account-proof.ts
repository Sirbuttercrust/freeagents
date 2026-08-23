// R-3, direction one (ENT-5): the agent's DID document carries a standard
// alsoKnownAs entry pointing at the agent's GitHub account. The operator
// authors that entry in their wallet tooling; this module is the pure
// decision of whether the document the identity adapter resolved actually
// points at the claimed account. No I/O: the document arrives as a plain
// field, so the rule can be lifted and verified without this service.

export function githubAccountUrl(handle: string): string {
  return `https://github.com/${handle}`;
}

// R-4, direction two (ENT-5): the operator (or the platform, later) publishes
// a public gist holding a plain-text statement that the agent's key signed.
// This module is the pure decision logic for that statement: parse the gist
// URL, build the canonical signed bytes, parse the statement, and decide
// whether a statement binds a given agent DID to a given handle. No I/O.

export interface GistUrlRef {
  readonly owner: string;
  readonly id: string;
}

// Total. A gist URL is exactly https://gist.github.com/<owner>/<id> (either
// scheme), non-empty owner and id, and nothing else: no port, query, hash or
// further path segment. Anything the URL parser cannot make sense of is null.
export function parseGistUrl(url: string): GistUrlRef | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname !== 'gist.github.com') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  if (segments.length !== 2) return null;
  const [owner, id] = segments;
  if (owner === undefined || id === undefined) return null;
  if (owner.length === 0 || id.length === 0) return null;
  return { owner, id };
}

// The exact bytes the statement's signature covers: LF line endings, trailing
// LF, the v1 marker, the agent DID, the account URL. A third party
// reconstructs these bytes from the gist alone (invariant 2), so the shape is
// fixed by the published statement format, not by this service.
export function gistProofPayload(did: string, github: string): string {
  return `freeagents-github-proof v1\n${did}\n${github}\n`;
}

export interface GistStatement {
  readonly did: string;
  readonly github: string;
  readonly signature: string;
}

// Total. Line-based `key: value`, keys case-insensitive, surrounding
// whitespace and CRLF tolerated, extra lines (the human-readable header, blank
// lines, anything without a colon) ignored. All four keys of the v1 format
// are required, else null; a non-1 version is a different format, also null.
// The value may contain colons (a DID does), so only the first colon splits.
export function parseGistStatement(content: string): GistStatement | null {
  if (typeof content !== 'string') return null;
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    values.set(key, value);
  }
  if (values.get('version') !== '1') return null;
  const did = values.get('did');
  const github = values.get('github');
  const signature = values.get('signature');
  if (did === undefined || did.length === 0) return null;
  if (github === undefined || github.length === 0) return null;
  if (signature === undefined || signature.length === 0) return null;
  return { did, github, signature };
}

// Does this statement bind this agent DID to this claimed handle? The DID is
// exact (the signature covers the exact bytes, so tolerance there would not
// help anyone); the GitHub account reuses the standard alsoKnownAs tolerance,
// because wallet tooling varies on case and trailing slash the same way it
// does for direction one.
export function statementBindsBinding(
  statement: GistStatement | null,
  did: string,
  handle: string,
): boolean {
  if (statement === null) return false;
  if (typeof statement !== 'object') return false;
  if (typeof statement.did !== 'string' || statement.did !== did) return false;
  if (typeof statement.github !== 'string') return false;
  return didDocumentPointsAtGithubAccount([statement.github], handle);
}

// ed25519 signatures are 64 bytes; base64 encodes those as 86 unpadded
// characters, or 88 with the canonical '==' padding.
const ED25519_SIGNATURE_BYTES = 64;

// Total: any value in, one boolean out, never a throw. True exactly when the
// string is a base64 encoding of exactly 64 bytes - the shape every standard
// ed25519 library emits for a signature. A real verify primitive throws on a
// signature it cannot decode, so the API runs this before calling it and
// maps false to 409 as malformed input, instead of letting garbage in the
// gist read as a platform outage.
export function signatureIsWellFormed(signature: string): boolean {
  if (typeof signature !== 'string') return false;
  const eq = signature.indexOf('=');
  const body = eq === -1 ? signature : signature.slice(0, eq);
  const padding = signature.slice(body.length);
  if (!/^[A-Za-z0-9+/_-]*$/.test(body)) return false;
  if (!/^={0,2}$/.test(padding)) return false;
  // Any body length outside the padding rules encodes no whole number of
  // bytes here: floor(length * 3 / 4) must be exactly the ed25519 size.
  return Math.floor((body.length * 3) / 4) === ED25519_SIGNATURE_BYTES;
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
