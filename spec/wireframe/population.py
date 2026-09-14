"""Which screens a gate measures, derived from the directory. Never a list.

WHY THIS FILE EXISTS, and it is the fourth round of one defect:

  round 1  verify_polish.py read r.height and never r.width, so a control
           20px wide passed. 13 real failures sat behind it.   AXIS-blind
  round 2  the axes were fixed and the SELECTOR stayed at `a,button`, so no
           input, select or label was measured.               SELECTOR-blind
  round 3  no gate opened a drawer before reading, so eleven controls behind
           one were invisible in both the broken and the fixed state. STATE-blind
  round 4  verify_ink.py named eight screens. Twenty-five on disk had never
           been measured against the AA rule that DESIGN.md, BUILD-STATE.md
           and the gate table all assert of every screen.       SCOPE-blind

Each round the fix landed on the instance a reviewer named, and each round
the same defect was already sitting somewhere else in another shape. Widening
verify_ink's list to thirty-three names would have been round four's version
of that, and round five would have found the next list.

A LIST OF NAMES IS THE DEFECT. A screen added next month is not in it, nothing
fails, and the green table goes on asserting a property of the whole set. So a
gate does not name its screens. It declares the RULE that decides which
screens its assertion applies to, and the rule is evaluated against the
directory every run:

    SCREENS = population.every_screen()
    SCREENS = population.screens_with_source("phead")

TWO THINGS MAKE THIS A GUARANTEE RATHER THAN A CONVENTION.

  1. verify_coverage.py fails any gate whose SCREENS is a literal list of
     names. Without it this module is a nicety that the next person in a
     hurry routes around, which is precisely how round 4 happened.
  2. The general 320px sweep takes the COMPLEMENT of the specialised one
     (see general_screens below), so the default for a new screen is
     covered. A partition whose fallback is "measured" cannot open a hole;
     one whose fallback is "not measured" opens one silently on the day a
     file is added.

A GATE THAT IS NARROW ON PURPOSE IS STILL DERIVED. verify_profile_header
measures two screens and that is correct, because two screens have a profile
header. What matters is that it measures the screens that HAVE one rather
than the two that happened to have one the day it was written.

No browser and no server: these are source reads, so a gate computes its
population before deciding whether to start Chrome.
"""

import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))


def every_screen():
    """Every screen in the directory.

    The right population for any rule the docs state of the whole set: AA
    contrast, the 44px floor, reduced motion, house style, duplicate
    accessible names, one accent primary per surface, money reconciliation,
    sample-data labelling. If the rule admits no exception, neither does the
    population.

    A gate whose subject only EXISTS on some screens still measures all of
    them: it finds nothing on the rest, which costs a page load and closes
    the hole where somebody adds a dollar figure to a screen no money gate
    was ever pointed at.
    """
    return sorted(os.path.basename(p)
                  for p in glob.glob(os.path.join(HERE, "*.html")))


def screens_with_source(needle, screens=None):
    """Screens whose SOURCE contains a string.

    For a gate about a component rather than about the set: the profile
    header, the decorative agent layer. The needle must be something the
    component cannot render without, so a screen that grows the component
    joins the population on its own.
    """
    out = []
    for s in (screens if screens is not None else every_screen()):
        with open(os.path.join(HERE, s), encoding="utf-8") as fh:
            if needle in fh.read():
                out.append(s)
    return sorted(out)


def screens_matching(pattern, screens=None):
    """Screens whose source matches a regex, for a shape rather than a name."""
    rx = re.compile(pattern)
    out = []
    for s in (screens if screens is not None else every_screen()):
        with open(os.path.join(HERE, s), encoding="utf-8") as fh:
            if rx.search(fh.read()):
                out.append(s)
    return sorted(out)


def screens_loading(asset, screens=None):
    """Screens that load a given stylesheet or script.

    A floor written in flow.css protects only the screens that load flow.css.
    This tree has paid for that twice, so a gate about one stylesheet's rules
    measures exactly the screens that load it.
    """
    return screens_with_source('"%s"' % asset, screens)


# THE PAYMENT FLOW, and the partition that cannot leak.
#
# The eight screens the card calls the payment flow are the six that load
# flow.css plus the two that draw the deal before any money moves: hire.html
# chooses the agent and sets the price, agreement.html is the signature
# matrix. Those two carry the flow's own layout in a page-local <style>, so a
# stylesheet test alone under-counts by exactly those two, and they are named
# here with that reason attached.
#
# THE ORDER OF THE TWO FUNCTIONS BELOW IS THE SAFETY ARGUMENT. general_screens
# is the COMPLEMENT of this set, not a second list. So a screen added next
# month is swept by the general instrument the moment it exists, whether or
# not anybody remembers this file. The specialised list can be wrong and still
# not open a coverage hole; the reverse arrangement, two lists that are each
# supposed to be complete, is what round 4 was.
FLOW_LAYOUT_IN_PAGE = {
    "hire.html": "the hire state machine, drawn in a page-local style block",
    "agreement.html": "the signature matrix, on agreement.css",
}


def payment_screens():
    """Screens the payment-flow instrument sweeps."""
    return sorted(set(screens_loading("flow.css")) | set(FLOW_LAYOUT_IN_PAGE))


def general_screens():
    """Everything else. The complement, so a new screen lands here by default."""
    return sorted(set(every_screen()) - set(payment_screens()))
