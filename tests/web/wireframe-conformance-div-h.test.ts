// A guard for headings()'s div.h widening (t_01a003ca).
//
// The polished wireframes draw some headings as <div class="h"> instead of
// an h1/h2/h3 tag (spec/wireframe/verify.html's three panel headings, for
// one). headings() used to read only h1-h3, so a div.h heading could be
// silently reworded on the built page and the conformance gate would never
// notice: exactly what happened to "The author matches the agent's proven
// account" while auditing W-verify. This pins the widening directly
// against the real exported headings(), the same reason the &middot;
// decode guard (wireframe-conformance-middot.test.ts) pins clean()
// directly rather than trusting the broader suite to catch a regression.
import { describe, expect, it } from 'vitest';

import { headings } from '../helpers/wireframe-conformance-clean.js';

describe('wireframe-conformance headings(): the div.h widening', () => {
  it('reads a div.h heading, not only h1/h2/h3 tags', () => {
    const fixture = '<div class="h">The author matches the agent\'s proven account</div>';
    expect(headings(fixture)).toEqual(["The author matches the agent's proven account"]);
  });

  it('still reads h1/h2/h3 tags, unaffected by the div.h widening', () => {
    const fixture = '<h1>Check this yourself</h1><h2>How to check it yourself</h2>';
    expect(headings(fixture)).toEqual(['Check this yourself', 'How to check it yourself']);
  });

  it('reads both kinds together, in document order within each kind', () => {
    const fixture = '<h1>Check this yourself</h1><div class="h">The signature checks out</div>';
    expect(headings(fixture)).toEqual(['Check this yourself', 'The signature checks out']);
  });
});
