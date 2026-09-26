// A guard for the apostrophe decodes in clean() (tests/helpers/wireframe-
// conformance-clean.ts), added by S3 for TRI1 (bugs.md, "clean() does not
// unescape entities"). Before the decode, a heading or control written with
// an apostrophe entity kept the entity as literal text, so the expected
// string built from a wireframe never matched a built page that used the
// real character, and an ALLOWED_ABSENT key had to carry the entity text to
// excuse it. This pins the decode against the real exported function, the
// same way wireframe-conformance-middot.test.ts pins &middot;.
import { describe, expect, it } from 'vitest';

import { clean, headings } from '../helpers/wireframe-conformance-clean.js';

describe('wireframe-conformance clean(): the apostrophe decodes', () => {
  it.each([
    ['the agent&#39;s account', "the agent's account"],
    ['the agent&#x27;s account', "the agent's account"],
    ['the agent&apos;s account', "the agent's account"],
    ['Didn&rsquo;t ship', 'Didn\u2019t ship'],
    ['Didn&#8217;t ship', 'Didn\u2019t ship'],
  ])('%s', (markup, expected) => {
    expect(clean(markup)).toBe(expected);
  });

  it('a heading written with an entity and one written with the character read the same', () => {
    expect(headings("<div class=\"h\">The agent&#39;s account</div>")).toEqual(headings("<div class=\"h\">The agent's account</div>"));
  });

  it('leaves the other decodes as they were', () => {
    expect(clean('Terms &amp; conditions')).toBe('Terms & conditions');
    expect(clean('Drop &middot; 3')).toBe('Drop \u00b7 3');
    expect(clean('Next &rarr; step')).toBe('Next step');
  });
});
