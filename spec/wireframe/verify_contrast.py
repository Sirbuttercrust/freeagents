#!/usr/bin/env python3
"""SUPERSEDED by verify_ink.py. Kept as a signpost, not as a gate.

This gate shelled out to a pixel sampler that lives outside this repository,
which is why review could not run it, and which is how a real contrast defect
shipped behind a green result. Two failures, one cause.

WHAT IT USED TO DO, AND WHY THAT WAS NOT ENOUGH

It sampled the pixel behind a text run and compared it with the text colour.
That instrument cannot see:

  * a filled button, where the pixel behind the label is the page rather than
    the button's own fill. Reported 1.01 on healthy buttons, and every one of
    those had to be disproved by hand.
  * a translucent surface, where the background needs compositing before it
    means anything. Reported 1.31 on a rail row that is genuinely fine.
  * text painted over a gradient, since one sample cannot find the worst
    point.

Because the noise had to be filtered by recognising known-good token values,
the filter also decided what counted as a finding, and an exemption written
into the stylesheet decided the rest. Between them, 45 real AA failures were
allowed through, including the `edit` control and the two party headers on
the agreement.

WHAT REPLACED IT

verify_ink.py makes every glyph transparent, photographs the page, and reads
the pixel where the characters actually sit. That pixel IS the background,
whatever produced it: a fill, a gradient, an ancestor's alpha. Then it
composites the ink over the measured colour with its real alpha and samples
five points per run, keeping the worst.

There is nothing left for the instrument to guess, so there are no artifacts
to disprove and no exemption list to argue about. It also needs nothing
outside this repository: standard library, plus wirebrowse.py beside it.

Run that instead:

    python3 devserver.py 3111 &
    python3 verify_ink.py http://127.0.0.1:3111
"""

import sys

print(__doc__)
print("verify_contrast.py is superseded. Run verify_ink.py.")
sys.exit(2)
