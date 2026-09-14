// A guard for the &middot; decode in tests/web/wireframe-conformance.
// test.ts's own clean(), which this card (W10) added. Without that
// decode, the expected string clean() builds from a wireframe control
// written with the HTML entity ("Drop \"verified hires\" &middot; 3
// results") carries the entity literally, never the real middle-dot
// character (\u00b7) browse.js actually renders (relaxationButton). A
// change that silently removed the decode would not fail the
// conformance suite itself -- ALLOWED_ABSENT.browse already excuses both
// affected strings, for the sample-digit reason, and would keep excusing
// them whether or not the entity decodes -- so this pins the decode
// directly, against the real exported function, rather than trusting a
// downstream test that cannot tell the difference.
import { describe, expect, it } from 'vitest';

import { clean } from '../helpers/wireframe-conformance-clean.js';

describe('wireframe-conformance clean(): the &middot; decode', () => {
  it('decodes &middot; to the real middle-dot character, matching what browse.js renders', () => {
    const wireframeMarkup = 'Drop "verified hires" &middot; 3 results';
    expect(clean(wireframeMarkup)).toBe('Drop "verified hires" \u00b7 3 results');
  });

  it('still decodes &amp; and strips &rarr;, unaffected by the &middot; addition', () => {
    expect(clean('Terms &amp; conditions')).toBe('Terms & conditions');
    expect(clean('Next &rarr; step')).toBe('Next step');
  });
});
