#!/usr/bin/env python3
"""DESIGN.md is normative, so every value it states is compared against the tree.

WHY THIS GATE EXISTS

Round 5 of review planted `#FF00FF` in DESIGN.md's normative token row and
watched five gates read straight past it:

    | `--fg-3` | `#FF00FF` | the quietest legible grey; unverifiable content |
      blind   verify_tokens.py   verify_housestyle.py   verify_coverage.py
      blind   verify_sitemap.py  verify_links.py                    exit 0

That was not hypothetical. The row really did hold `#666B73` while `base.css`
had shipped `#7C828C` since August, and section 2.5 reasoned from the stale
value in prose: it told a builder the token fails AA at 12 and 13px and
therefore paints no characters on the flow screens. Measured, the shipped
value clears AA on all three surfaces and paints 268 character runs across the
set. Three sentences, all describing a branch that no longer exists, in the
document the rebuild cards are told to read as the design source.

WHAT MAKES THIS THE FIFTH SHAPE OF ONE DEFECT

  round 1  a probe read one axis                       AXIS-blind
  round 2  a probe read `a,button` only                SELECTOR-blind
  round 3  no probe opened a drawer                    STATE-blind
  round 4  verify_ink.py named eight screens           SCOPE-blind
  round 5  four gates named one page inline            SCOPE-blind again
  round 6  the normative document was read by nothing  SOURCE-blind

`verify_tokens.py` already did the right cross-read in the right direction,
comparing its own literals against `base.css` and failing on drift. It could
not have caught this one: it holds seven literals out of forty-five shipped
tokens, and it never opens DESIGN.md at all. A rule enforced over a list
cannot fail on the entry the list does not mention, which is the sentence
this tree has now written five times.

So neither side of every comparison below is written down. `tokens.py` reads
the shipped set out of every stylesheet in the directory and the documented
set out of the document's own table shape, and this gate compares them.

WHAT IT CHECKS

  A  a token in both that disagrees                    (the round-5 defect)
  B  a token the document gives a value to that no stylesheet defines
  C  a token the tree ships that the document neither states nor excludes
     with a reason, so the table cannot be silently partial
  D  a contrast ratio stated in prose that the shipped tokens do not produce
  E  a duration stated in prose that no stylesheet ships

D and E are the part that matters more than the values. A stale hex is one
wrong fact; a PARAGRAPH reasoning from a stale hex sends the next builder
somewhere false while sounding authoritative, and prose is exactly what no
gate in this directory was reading.

No browser and no server: this reads source.

    python3 verify_designmd.py
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tokens                                                    # noqa: E402

DOC = "DESIGN.md"

# A token may go undocumented ONLY with its reason recorded here, where a
# reviewer reads it, rather than by being absent from a table nobody audits.
#
# THE DISTINCTION: section 2.1 says "No screen may introduce a hex value. A
# colour that is not in this table does not exist in the product." That is a
# claim about the PALETTE, the colours a person can see and name. A geometry
# constant, an easing curve or a surface recipe is not a palette entry, and
# listing it in the colour table would bury the twelve colours that rule is
# actually about. Each exclusion below says which of those it is.
UNDOCUMENTED_WITH_REASON = {
    "--r": "corner radius, a geometry constant. Section 4 owns space.",
    "--w": "the content width. Section 4 states it in prose, in px.",
    "--w-wide": "the marketplace grid width. market.css states its own reason.",
    "--ease": "an easing curve, not a value a screen picks. Section 6 owns motion.",
    "--ease-out-q": "an easing curve. Same as --ease.",
    "--dur-1": "a duration token. Section 6 names it in prose with its use.",
    "--dur-2": "a duration token. Section 6 names it in prose with its use.",
    "--dur-3": "a duration token. Section 6 names it in prose with its use.",
}

# Ratio claims, in the two shapes this document states them.
#
# SHAPE 1, prose: "`--fg-3` on `--bg` measures **3.72:1**, and on `--bg-2`
# **3.41:1**". Matched by the tokens it names, so a sentence that moves to
# another section keeps being checked.
_RATIO = re.compile(
    r"`(--[a-z0-9-]+)`\s+on\s+`(--[a-z0-9-]+)`\s+measures\s+\*\*(\d+\.\d+):1\*\*"
    r"(?:,\s*and\s+on\s+`(--[a-z0-9-]+)`\s+\*\*(\d+\.\d+):1\*\*)?")

# SHAPE 2, a table: a header row whose cells name surfaces as `on `--bg``, and
# body rows whose first cell is an ink token and whose remaining cells are
# bare ratios.
#
# READING THE TABLE IS NOT OPTIONAL, and this is the part round 6 nearly got
# wrong. The first version of this gate read only shape 1, so the fix for a
# stale prose ratio was to move the numbers into a table, and the moment they
# landed there the gate reported "ratio claims checked: 0" and went green. A
# gate whose coverage collapses when the document is reorganised is the
# SCOPE-blind defect one more time, in the instrument written to close it.
_RATIO_HEAD = re.compile(r"^\|\s*ink\s*\|(.+)\|\s*$", re.M | re.I)
_ON_TOKEN = re.compile(r"on\s+`(--[a-z0-9-]+)`")


def _table_ratio_claims(text):
    """Ratio claims written as a table: an ink column and one column per surface."""
    out = []
    for head in _RATIO_HEAD.finditer(text):
        surfaces = [_ON_TOKEN.search(c) for c in head.group(1).split("|")]
        surfaces = [m.group(1) if m else None for m in surfaces]
        if not any(surfaces):
            continue
        # Walk the rows under this header until the table ends.
        pos = text.index("\n", head.end()) + 1
        for line in text[pos:].split("\n"):
            if not line.startswith("|"):
                break
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if not cells or not cells[0].startswith("`--"):
                continue                       # the |---|---| separator row
            ink = cells[0].strip("`")
            line_no = text[:text.index(line, pos)].count("\n") + 1
            for i, cell in enumerate(cells[1:]):
                if i >= len(surfaces) or not surfaces[i]:
                    continue
                if re.fullmatch(r"\d+\.\d+", cell):
                    out.append((ink, surfaces[i], float(cell), line_no))
    return out


# A ratio stated in ANY table cell alongside a token row, e.g. the discipline
# tints, whose header names one surface for the whole table.
_TINT_HEAD = re.compile(r"^\|\s*token\s*\|.*\|\s*on\s+`(--[a-z0-9-]+)`\s*\|\s*$",
                        re.M | re.I)


def _tint_ratio_claims(text):
    """A token table whose LAST column is that token's ratio on one surface."""
    out = []
    for head in _TINT_HEAD.finditer(text):
        bg = head.group(1)
        pos = text.index("\n", head.end()) + 1
        for line in text[pos:].split("\n"):
            if not line.startswith("|"):
                break
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if not cells or not cells[0].startswith("`--"):
                continue
            if not re.fullmatch(r"\d+\.\d+", cells[-1]):
                continue                       # "n/a" for a translucent token
            line_no = text[:text.index(line, pos)].count("\n") + 1
            out.append((cells[0].strip("`"), bg, float(cells[-1]), line_no))
    return out

# "Durations: **120ms** ... **240ms** ..." Any bolded millisecond figure in the
# motion section is a claim that the tree uses that number.
_MS = re.compile(r"\*\*(\d+)ms\*\*")


# SHAPE 3, a HISTORICAL claim: "It was `#666B73` ... where it measured 3.72:1
# on `--bg` and 3.41:1 on `--bg-2`". The ink is a literal hex rather than a
# token, because the token no longer holds it.
#
# THESE HAVE TO BE CHECKED TOO, and it is tempting to skip them. A number
# about a value the tree stopped using cannot be recomputed from the shipped
# tokens, so the two checks above are structurally blind to it, and "it is
# only history" is the argument that would leave the last unchecked ratio in
# the file sitting in the exact paragraph this whole round is about. A hex is
# a hex: contrast(#666B73, --bg) is 3.72 today and forever, so the claim is
# verifiable and stays verified.
_HIST = re.compile(
    r"`(#[0-9A-Fa-f]{6})`(?:(?!\n\n).)*?measured\s+(\d+\.\d+):1\s+on\s+`(--[a-z0-9-]+)`"
    r"(?:\s+and\s+(\d+\.\d+):1\s+on\s+`(--[a-z0-9-]+)`)?", re.S)


def _historical_ratio_claims(text):
    """Ratios stated against a literal hex, for a value the tree no longer ships."""
    out = []
    for m in _HIST.finditer(text):
        line = text[:m.start()].count("\n") + 1
        out.append((m.group(1), m.group(3), float(m.group(2)), line))
        if m.group(4):
            out.append((m.group(1), m.group(5), float(m.group(4)), line))
    return out


def ratio_claims(text):
    """Every ratio claim in the document, prose and table alike.

    Deduplicated on (ink, surface, line): the same pair stated twice in one
    place is one claim, and reporting it twice would make a single stale
    number look like two defects.
    """
    out = []
    for m in _RATIO.finditer(text):
        line = text[:m.start()].count("\n") + 1
        out.append((m.group(1), m.group(2), float(m.group(3)), line))
        if m.group(4):
            out.append((m.group(1), m.group(4), float(m.group(5)), line))
    out += _table_ratio_claims(text)
    out += _tint_ratio_claims(text)
    out += _historical_ratio_claims(text)
    seen, uniq = set(), []
    for c in out:
        if c in seen:
            continue
        seen.add(c)
        uniq.append(c)
    return sorted(uniq, key=lambda c: (c[3], c[0], c[1]))


def duration_claims(text):
    """Every bolded millisecond figure, with the line it sits on."""
    out = []
    for m in _MS.finditer(text):
        out.append((int(m.group(1)), text[:m.start()].count("\n") + 1))
    return out


def shipped_durations():
    """Every transition and animation DURATION the stylesheets ship, in ms.

    A shorthand's SECOND time value is the delay, not the duration, and
    counting it produces a confident wrong number: `flow-pulse 2.6s ease 1.75s`
    runs for 2.6s and starts 1.75s late, and a probe that reads both reports a
    1750ms duration nothing has. Same for `transition-delay`, which holds no
    duration at all. Only the first time value in each declaration counts.
    """
    import glob
    comment = re.compile(r"/\*.*?\*/", re.S)
    dur = re.compile(r"(?<![\w-])(\d*\.?\d+)(m?s)(?![\w-])")
    out = {}
    for path in sorted(glob.glob(os.path.join(HERE, "*.css"))):
        name = os.path.basename(path)
        src = comment.sub("", open(path, encoding="utf-8").read())
        # Split into declarations so a line holding two transitions gives two
        # durations rather than one duration and one misread delay.
        for decl in re.split(r"[;{}]", src):
            if not re.search(r"transition|animation|--dur-", decl):
                continue
            if re.search(r"(transition|animation)-delay", decl):
                continue
            # A shorthand lists one time per COMMA-separated part.
            for part in decl.split(","):
                found = dur.findall(part)
                if not found:
                    continue
                num, unit = found[0]
                ms = round(float(num) * (1000 if unit == "s" else 1))
                out.setdefault(ms, set()).add(name)
    return out


def main():
    text = open(os.path.join(HERE, DOC), encoding="utf-8").read()
    ship = tokens.shipped()
    doc = tokens.documented(DOC)
    fails = []

    # AN EMPTY POPULATION IS NOT A PASS. This is the trap a derivation opens
    # that a hardcoded list does not: rename :root, restructure the table, and
    # every loop below runs zero times and prints the same green as a working
    # sweep. Round 5 paid for this lesson on four gates at once.
    if not ship:
        fails.append("no :root custom properties found in any stylesheet. "
                     "The derivation matched nothing, which is a broken "
                     "instrument, not a clean tree.")
    if not doc:
        fails.append("no token rows found in %s. The table shape this gate "
                     "reads (| `--token` | `value` | ...) matched nothing." % DOC)

    # ---- A. the round-5 defect: a value in both that disagrees -----------
    drift = []
    for name, (dv, line) in sorted(doc.items()):
        if name not in ship:
            continue
        sv, where = ship[name]
        if tokens.normalise(sv) != tokens.normalise(dv):
            drift.append((name, dv, line, sv, where))
            fails.append(
                "%s:%d  `%s` is documented as %s and %s ships %s.\n"
                "      DESIGN.md is normative, so a builder rebuilding from it "
                "is handed a value\n      the branch does not use."
                % (DOC, line, name, dv, where, sv))

    # ---- B. documented, not shipped --------------------------------------
    ghosts = sorted(set(doc) - set(ship))
    for name in ghosts:
        fails.append(
            "%s:%d  `%s` has a documented value and NO stylesheet defines it. "
            "A token\n      row nothing backs is a colour that does not exist."
            % (DOC, doc[name][1], name))

    # ---- C. shipped, neither documented nor excluded with a reason -------
    silent = sorted(set(ship) - set(doc) - set(UNDOCUMENTED_WITH_REASON))
    for name in silent:
        sv, where = ship[name]
        # Say WHICH rule the token breaks. A geometry constant reported with
        # section 2.1's colour sentence sends the reader to the wrong table
        # and teaches them to skim this gate's output.
        rule = ("Section 2.1: a colour not in the table does not exist in "
                "the product." if tokens.as_rgb(sv)
                else "A value the tree ships and the design source never "
                     "mentions cannot be rebuilt from the document.")
        fails.append(
            "%s defines `%s: %s` and %s neither states it nor excludes it.\n"
            "      %s\n"
            "      Add the row, or add the token to UNDOCUMENTED_WITH_REASON "
            "in this file\n      WITH the reason."
            % (where, name, sv, DOC, rule))

    stale_exclusions = sorted(set(UNDOCUMENTED_WITH_REASON) - set(ship))
    for name in stale_exclusions:
        fails.append(
            "UNDOCUMENTED_WITH_REASON excuses `%s`, which no stylesheet "
            "defines any more.\n      An exemption outliving its subject is "
            "how the next real one gets waved through." % name)

    # ---- D. a ratio stated in prose that the tokens do not produce -------
    ratios = ratio_claims(text)

    def _ink(name):
        """Resolve a claim's ink, which is a token OR a literal historical hex."""
        if name.startswith("#"):
            return tokens.as_rgb(name), name
        if name not in ship:
            return None, None
        return tokens.as_rgb(ship[name][0]), ship[name][0]

    for ink, bg, claimed, line in ratios:
        a, avalue = _ink(ink)
        b = tokens.as_rgb(ship[bg][0]) if bg in ship else None
        if a is None or b is None:
            fails.append(
                "%s:%d  claims a ratio for `%s` on `%s`, and one of them is "
                "not an opaque\n      colour this tree defines, so no single "
                "ratio exists." % (DOC, line, ink, bg))
            continue
        real = tokens.contrast(a, b)
        if abs(real - claimed) > 0.05:
            fails.append(
                "%s:%d  says `%s` on `%s` measures %.2f:1. %s on `%s` "
                "measures %.2f:1.\n      A paragraph reasoning from a stale "
                "number is worse than the number: it\n      sounds "
                "authoritative and sends the next builder somewhere false."
                % (DOC, line, ink, bg, claimed, avalue, bg, real))

    # ---- E. a duration stated in prose that nothing ships -----------------
    ships_ms = shipped_durations()
    durs = duration_claims(text)
    for ms, line in durs:
        if ms not in ships_ms:
            fails.append(
                "%s:%d  names **%dms** and no stylesheet uses it.\n"
                "      Section 6 used to name three durations and say "
                "'Nothing else' while the\n      tree shipped nineteen. A "
                "number in prose that nothing checks goes stale the\n"
                "      day after it is written." % (DOC, line, ms))

    # ---- F. a script named as available that is not on disk ---------------
    #
    # Same class as D13 and found by the same survey. Section 4.1 said
    # "`measure_density.py` in this directory measures a live page against
    # these numbers" while section 10 of the SAME FILE said the two density
    # scripts "do not exist on this branch". A document that contradicts
    # itself about what a reader can run is worse than one that says nothing,
    # because the reader who starts at 4.1 never reaches 10.
    #
    # CHECKED PER SENTENCE, NOT BY PROXIMITY. The first version of this check
    # excused a name when an absence phrase appeared within 400 characters,
    # and its own mutation control MISSED: the phrase that excused the planted
    # defect was in the very sentence describing THIS GATE ("fails if this
    # file ever names a script here that is not on disk"). A window is a guess
    # about where a qualifier lives. The definition is that the sentence
    # making the claim has to carry it, so a paragraph cannot launder a false
    # statement by sitting next to a true one.
    named_scripts = sorted(set(re.findall(r"`([a-z_0-9]+\.py)`", text)))
    absent = [s for s in named_scripts
              if not os.path.exists(os.path.join(HERE, s))]
    marker = re.compile(r"do(?:es)? not exist|not on disk|as absent|"
                        r"unmerged|never existed", re.I)
    # Join wrapped lines inside a paragraph before splitting, or a name and
    # its qualifier land in different "sentences" purely because of where the
    # text was hard-wrapped.
    flat = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    for s in absent:
        for sentence in re.split(r"(?<=[.!?])\s+", flat):
            if "`%s`" % s not in sentence:
                continue
            if marker.search(sentence):
                continue
            line = text[:text.index("`%s`" % s)].count("\n") + 1
            fails.append(
                "%s:%d  names `%s` in a sentence that presents it as "
                "available:\n      %r\n"
                "      It is not in this directory. A script a reader cannot "
                "run is a claim,\n      not a check. Say it is absent IN THAT "
                "SENTENCE, the way section 10 does."
                % (DOC, line, s, sentence.strip()[:100]))

    # ---- G. a token table whose rows do not match its header --------------
    #
    # Found by looking at the rendered document rather than by any check: the
    # `--eye` row was added to section 2.4 with three cells under a two-cell
    # header, so a markdown renderer drops the third and the reason for the
    # token vanishes from the page while remaining in the source. A gate that
    # reads the source is blind to what a reader actually sees, which is the
    # same gap in a different medium.
    for block in re.finditer(r"^\|(?:[^\n]*\|)\n\|[-\s|:]+\|\n((?:\|[^\n]*\|\n)+)",
                             text, re.M):
        head = text[block.start():text.index("\n", block.start())]
        width = head.count("|") - 1
        start_line = text[:block.start()].count("\n") + 1
        for i, row in enumerate(block.group(1).rstrip("\n").split("\n")):
            if row.count("|") - 1 != width:
                fails.append(
                    "%s:%d  a table row has %d cells under a %d-cell header:\n"
                    "      %s\n      A renderer drops the extras, so the "
                    "reason for a token disappears from\n      the page while "
                    "still sitting in the source."
                    % (DOC, start_line + 2 + i, row.count("|") - 1, width,
                       row.strip()[:96]))

    # ---- the report ------------------------------------------------------
    print("=" * 78)
    print("verify_designmd.py  the normative document against the tree")
    print("=" * 78)
    print()
    print("stylesheets read:          %d  (%s)"
          % (len(tokens.stylesheets()), " ".join(tokens.stylesheets())))
    print("tokens shipped:            %d  derived from every :root block" % len(ship))
    print("tokens documented:         %d  derived from the table shape in %s"
          % (len(doc), DOC))
    print("tokens excluded by hand:   %d  each with its reason in this file"
          % len(UNDOCUMENTED_WITH_REASON))
    print("ratio claims checked:      %d" % len(ratios))
    print("duration claims checked:   %d  against %d distinct shipped values"
          % (len(durs), len(ships_ms)))
    print("scripts named in %-9s %d  of which %d are on disk"
          % (DOC + ":", len(named_scripts), len(named_scripts) - len(absent)))
    if absent:
        print("%-26s %s  named as absent, with the reason stated"
              % ("", " ".join(absent)))
    print()

    # An accounting line that can exceed the total is a broken instrument, not
    # a clean tree. This printed "46 of 45" for one commit because a token
    # both documented AND excluded was counted twice, and a number a reader
    # can see is impossible teaches them to distrust the rest of the output.
    both = sorted(set(ship) & set(doc) & set(UNDOCUMENTED_WITH_REASON))
    for name in both:
        fails.append(
            "`%s` is documented in %s AND excused in UNDOCUMENTED_WITH_REASON. "
            "Pick one:\n      an exemption beside a real row is an argument "
            "nobody will re-read." % (name, DOC))
    accounted = set(ship) & (set(doc) | set(UNDOCUMENTED_WITH_REASON))
    print("every shipped token is accounted for: %d of %d"
          % (len(accounted), len(ship)))

    if ratios:
        print()
        print("ratios, recomputed from the shipped values:")
        for ink, bg, claimed, line in ratios:
            a, _ = _ink(ink)
            b = tokens.as_rgb(ship[bg][0]) if bg in ship else None
            real = tokens.contrast(a, b) if a and b else float("nan")
            print("  %s:%-4d %-14s on %-8s doc %5.2f   tree %5.2f   %s"
                  % (DOC, line, ink, bg, claimed, real,
                     "PASS" if real >= 4.5 else "below AA, stated as history"))

    if fails:
        print()
        print("FAIL: %d disagreement(s) between %s and the tree." % (len(fails), DOC))
        for f in fails:
            print("  " + f)
        print()
        print("DESIGN.md is what the rebuild cards read as the design source.")
        print("A value in it that the branch does not ship is not a typo, it is")
        print("an instruction to build the wrong thing.")
        return 1

    print()
    print("PASS  every value %s states is the value the tree ships, every" % DOC)
    print("      shipped token is documented or excluded with a reason, and")
    print("      every ratio and duration in prose recomputes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
