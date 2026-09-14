// Shared with tests/web/wireframe-conformance.test.ts and tests/web/
// wireframe-conformance-middot.test.ts. Not a *.test.ts file itself, so
// vitest never collects it as its own test file: importing it costs
// nothing extra at collection time, unlike importing a .test.ts module,
// which re-runs every describe/it it contains as a side effect of the
// import.
//
// clean() is the one function the &middot; decode guard needs to call
// directly, against the real implementation, so a future edit that
// silently drops the decode fails a test rather than only failing (or
// not failing) the conformance suite's own broader assertions.
export function clean(s: string): string {
  // &middot; decode, added by W10. The wireframe writes the two zero-state
  // relaxation buttons with the HTML entity ("Drop \"verified hires\"
  // &middot; 3 results"); browse.js emits the real character (\u00b7) for
  // the same control (relaxationButton). Without this decode the expected
  // string built from the wireframe carried the literal entity text, so
  // the ALLOWED_ABSENT entries for these two controls were excusing them
  // for the wrong reason: their keys matched the un-decoded &middot; text,
  // when the reason they are absent is only ever the sample digits ("3
  // results", "12 results"). This is a correction to how the instrument
  // reads a wireframe, never a loosening of what it demands: verified
  // across all 22 compared pages (with and without this decode) that the
  // ONLY assertions it changes are these two browse strings, and both of
  // those ALLOWED_ABSENT entries stay in place with their keys corrected
  // to the decoded \u00b7 character in wireframe-conformance.test.ts.
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&middot;/g, '\u00b7').replace(/&rarr;|→/g, '').replace(/\s+/g, ' ').trim();
}
