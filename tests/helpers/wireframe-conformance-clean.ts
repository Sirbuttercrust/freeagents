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
  // relaxation buttons with the HTML entity ('Drop "verified hires"
  // &middot; 3 results'); browse.js emits the real character (middle dot)
  // for the same control (relaxationButton). Without this decode the
  // expected string built from the wireframe carried the literal entity
  // text, so the ALLOWED_ABSENT entries for these two controls were
  // excusing them for the wrong reason: their keys matched the
  // un-decoded &middot; text, when the reason they are absent is only
  // ever the sample digits ('3 results', '12 results'). This is a
  // correction to how the instrument reads a wireframe, never a
  // loosening of what it demands: verified across all 22 compared pages
  // (with and without this decode) that the ONLY assertions it changes
  // are these two browse strings, and both of those ALLOWED_ABSENT
  // entries stay in place with their keys corrected to the decoded
  // middle-dot character in wireframe-conformance.test.ts.
  //
  // The apostrophe decodes, added by S3 (TRI1). A page or wireframe that
  // writes an apostrophe as an entity (&#39;, &#x27;, &apos;) or a right
  // single quote as one (&rsquo;, &#8217;) is read here as the character a
  // person sees, the same correction the &middot; decode makes. The one
  // string this changes today is myjobs' chip "Didn&#8217;t ship", on both
  // sides of the comparison; its ALLOWED_ABSENT key is re-keyed to the
  // decoded form in wireframe-conformance.test.ts with its reason unchanged.
  // Pinned by wireframe-conformance-apostrophe.test.ts.
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '\u00b7')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&rsquo;|&#8217;/g, '\u2019')
    .replace(/&rarr;|→/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// strip() and headings() moved here from wireframe-conformance.test.ts so a
// guard test can import the real exported headings(), not a copy, the same
// reason clean() lives here (see the file header above this function).
export function strip(htmlText: string): string {
  return htmlText
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div class="note"[\s\S]*?<\/div>\s*<\/div>/g, '')
    .replace(/<div class="note"[\s\S]*?<\/div>/g, '');
}

// The wireframes draw headings two ways: the semantic h1/h2/h3 tags, and
// the polished wireframes' own div.h heading class (see verify.html's three
// "The signature checks out" / "The pull request is real, and it merged" /
// "The author matches the agent's proven account" panels). A gate that
// reads only h1-h3 cannot see the second kind, which is how a div.h
// heading was silently reworded on a built page while this suite stayed
// green (t_01a003ca). Pinned by wireframe-conformance-div-h.test.ts.
export function headings(htmlText: string): string[] {
  const tagHeadings = [...strip(htmlText).matchAll(/<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => clean(m[2] ?? ''));
  const divHeadings = [...strip(htmlText).matchAll(/<div class="h"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => clean(m[1] ?? ''));
  return [...tagHeadings, ...divHeadings].filter((h) => h.length > 0);
}
