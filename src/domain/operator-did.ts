// Operator DID shape (spec/entities.md ENT-1, line 24: `did:abt:...`, and
// ENT-1.1: the DID is created by the operator, never by us). This checks the
// shape of a DID the operator already holds; it never creates one, because a
// service that mints operator DIDs is a service that holds the key, which is
// exactly what ENT-1.1 forbids.

// Total and never throws: every string in, one boolean out. Callers map a
// false to their own error (a 400 in the API), so the domain stays free of
// exception types and HTTP vocabulary alike.
export function isValidOperatorDid(value: string): boolean {
  // The method is case-sensitive (spec/entities.md:24 shows it lowercase),
  // so the prefix is compared exactly, not case-insensitively: a "DID:abt:"
  // string is a different string, not a typo of the same one.
  if (!value.startsWith('did:abt:')) return false;

  const suffix = value.slice('did:abt:'.length);
  if (suffix.length === 0) return false;

  // Whitespace in the suffix would also break the GET /operators/:did URL
  // path, so it is refused here rather than in the route, where the reason
  // would read as a transport detail.
  if (/\s/.test(suffix)) return false;

  // A bound, not a guess at multibase length. ArcBlock's exact suffix shape
  // belongs to R-2 (the key arrives with it); when it lands, this single
  // function is the one place the rule tightens.
  if (value.length > 256) return false;

  return true;
}
