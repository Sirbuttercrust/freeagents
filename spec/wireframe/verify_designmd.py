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


def css_ratio_claims():
    """Every contrast ratio asserted in a STYLESHEET comment, with its pair.

    THE SECOND MEDIUM THE SAME DEFECT LIVES IN.

    `market.css` said "Dark ink on a solid amber measures 8.85:1" beside a
    pair that measures 8.34. The number had been copied from `agreement.css`,
    where it describes a different pair and is correct. Nothing recomputed it,
    because every ratio check in this directory reads `DESIGN.md` and this
    tree writes its reasoning in stylesheet comments as a matter of house
    style: nineteen ratio-shaped numbers live in `.css` files.

    A ratio in a comment is a SECOND COPY of a number that is derivable. Copies
    go stale, and this one sat next to the value it described while being wrong
    about it, which is the most persuasive way to be wrong.

    RESOLVING THE PAIR IS THE HARD HALF, AND GUESSING AT IT IS THE DEFECT.

    The first version of this function took "the two most distant colours
    mentioned nearby" and produced five confident wrong pairs on its first
    run: it read `flow.css`'s note about the OLD `#666B73` as a claim about
    `--fg-3`, and it read `market.css`'s note about a wash that no longer
    exists as a claim about the fill that replaced it. Every one of those
    would have been a real failure printed against a correct stylesheet. A
    gate that cries wolf is retired by the first person who reads it, and
    then the real drift goes through.

    So a claim is checked only when its pair is UNAMBIGUOUS:

      * the clause holding the number names exactly two resolvable colours, or
      * the clause names none, and the rule immediately below the comment
        declares both a `color` and a `background` that resolve

    A clause in the past tense is not checked at all and is reported as
    history: "it used to measure 4.94" is a fact about a value the tree no
    longer ships, and recomputing it from today's tokens answers a different
    question. Everything unresolved is PRINTED, because a checker whose
    coverage is invisible is how `ratio claims checked: 0` printed green.

    Returns (checked, unresolved, historical).
    """
    import glob
    # Past tense: this clause is about a value the tree no longer ships.
    hist = re.compile(r"\b(?:was|were|used to|had been|previously|"
                      r"before the lift|until|old|former)\b", re.I)
    out, unresolved, historical = [], [], []
    ship = tokens.shipped()
    for path in sorted(glob.glob(os.path.join(HERE, "*.css"))):
        name = os.path.basename(path)
        src = open(path, encoding="utf-8").read()
        for cm in re.finditer(r"/\*.*?\*/", src, re.S):
            body = cm.group(0)
            # What the rule under this comment paints. That is the pair a
            # sentence like "dark ink on a solid amber" is describing without
            # naming either value.
            tail = src[cm.end():cm.end() + 700]
            block = {}
            for prop in ("color", "background"):
                dm = re.search(r"[;{\s]%s\s*:\s*([^;}]+)" % prop, tail)
                if not dm:
                    continue
                val = dm.group(1).strip()
                vm = re.match(r"var\(\s*(--[a-zA-Z0-9-]+)", val)
                if vm and vm.group(1) in ship:
                    block[prop] = (vm.group(1), tokens.as_rgb(ship[vm.group(1)][0]))
                else:
                    block[prop] = (val, tokens.as_rgb(val))
            for rm in re.finditer(r"(\d+\.\d+):1", body):
                claimed = float(rm.group(1))
                line = src[:cm.start() + rm.start()].count("\n") + 1
                # The CLAUSE, not the sentence: "measured 8.97:1 on --bg and
                # 8.85:1 as dark ink on the fill" is two claims about two
                # pairs, and resolving them together gets one of them wrong.
                seg = body[max(0, rm.start() - 260):rm.end()]
                clause = re.split(r"(?<=[.!?])\s|,\s+and\s+|\s+and\s+|;\s*", seg)[-1]
                if hist.search(clause):
                    historical.append((name, line, claimed, clause.strip()[:66]))
                    continue
                named = []
                for tok in re.findall(r"--[a-zA-Z0-9-]+", clause):
                    if tok in ship and tokens.as_rgb(ship[tok][0]):
                        named.append((tok, tokens.as_rgb(ship[tok][0])))
                for h in re.findall(r"#[0-9A-Fa-f]{6}\b", clause):
                    named.append((h, tokens.as_rgb(h)))
                uniq, seen = [], set()
                for label, rgb in named:
                    if rgb in seen:
                        continue
                    seen.add(rgb)
                    uniq.append((label, rgb))
                if len(uniq) >= 2:
                    a, b = uniq[0], uniq[1]
                elif not uniq and len(block) == 2 and all(v[1] for v in block.values()):
                    a, b = block["color"], block["background"]
                else:
                    unresolved.append((name, line, claimed, clause.strip()[:66]))
                    continue
                out.append((name, line, claimed, tokens.contrast(a[1], b[1]),
                            "%s on %s" % (a[0], b[0])))
    return out, unresolved, historical


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
    if not tokens.literals():
        fails.append("no colour literals found in any file. Every stylesheet "
                     "in this tree holds\n      dozens, so a zero here is the "
                     "derivation matching nothing, not a clean tree.")

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

    # ---- H. a screen or stylesheet that introduces a colour ---------------
    #
    # SECTION 2.1, READ IN THE DIRECTION IT IS WRITTEN.
    #
    #     No screen may introduce a hex value. A colour that is not in this
    #     table does not exist in the product.
    #
    # Every check above reads the token DEFINITIONS: it answers "what colours
    # does the product have". 2.1's sentence is about SCREENS, and until this
    # round nothing in the directory ever opened an HTML file looking for a
    # colour. Twenty-three gates passed a tree where nine screens painted an
    # inline `<circle fill="#3A3A4A">` into the account menu, and a planted
    # `#D8D8D8` swatch (chosen to CLEAR AA, so no contrast gate could catch it
    # for the wrong reason) went green on all twenty-three.
    #
    # The population is derived, not listed, and classified by POSITION rather
    # than by value: `#418` in a paragraph is a pull request number, `#418` in
    # a `fill=` is paint. See tokens.literals().
    lits = tokens.literals()
    ship_values = {tokens.normalise(v) for v, _ in ship.values()}
    paints = [x for x in lits if x["kind"] == "paint"]
    css_html = [x for x in paints if not x["file"].endswith(".js")]
    for lit in css_html:
        fails.append(
            "%s:%d  paints `%s`, which no token defines.\n"
            "      %s\n"
            "      %s 2.1: a colour that is not in the token table does not "
            "exist in\n      the product. Give it a token, or use the one "
            "that already holds it."
            % (lit["file"], lit["line"], lit["value"], lit["context"], DOC))

    # ---- I. a renderer's copy of a token that no longer matches it --------
    #
    # A generative renderer works in a colour space, so it holds literals that
    # are NOT palette entries: twelve arcade hues, a white and a black to mix
    # toward. Those are section 2.4's subject and 2.1 does not reach them.
    #
    # Three of them are different: they are COPIES of tokens. `swarm.js` holds
    # `RESERVED = { hex: "#7C7CFF" }`, the accent, used to keep a hue band
    # empty so a generated agent can never come out wearing the colour that
    # means verified. Move `--accent` and that guard reserves the old hue: the
    # product silently breaks 2.2 and nothing fails.
    #
    # So a copy has to declare itself with `/* = --token */` beside the value,
    # and every declared copy is recomputed here. The claim lives where the
    # value lives, which is the only place it cannot be forgotten.
    for lit in paints:
        name = lit["mirror"]
        if not name:
            continue
        if name not in ship:
            fails.append(
                "%s:%d  declares `%s` a copy of `%s`, and no stylesheet "
                "defines that token."
                % (lit["file"], lit["line"], lit["value"], name))
        elif tokens.normalise(lit["value"]) != tokens.normalise(ship[name][0]):
            fails.append(
                "%s:%d  holds %s and calls it `%s`, which %s ships as %s.\n"
                "      A renderer reasoning from a stale copy of a token "
                "keeps obeying the old\n      value after the product has "
                "moved, and every gate stays green."
                % (lit["file"], lit["line"], lit["value"], name,
                   ship[name][1], ship[name][0]))

    # A renderer literal that happens to equal a shipped token and does NOT
    # say so is the same defect waiting to happen, so it is named rather than
    # ignored. Reported as a fail with the annotation as the fix, because the
    # alternative is a reader deciding case by case whether a copy is a copy.
    for lit in [x for x in paints if x["file"].endswith(".js")]:
        if lit["mirror"]:
            continue
        if tokens.normalise(lit["value"]) in ship_values:
            match = [n for n, (v, _) in ship.items()
                     if tokens.normalise(v) == tokens.normalise(lit["value"])]
            fails.append(
                "%s:%d  holds %s, which is the value of %s, and does not say "
                "so.\n      %s\n      Annotate it `/* = %s */` so it is "
                "recomputed when the token moves,\n      or change the value "
                "so it is not a silent copy."
                % (lit["file"], lit["line"], lit["value"],
                   " and ".join("`%s`" % n for n in sorted(match)),
                   lit["context"], sorted(match)[0]))

    # ---- J. a contrast ratio asserted in a stylesheet comment -------------
    css_ratios, css_unresolved, css_historical = css_ratio_claims()
    for name, line, claimed, real, pair in css_ratios:
        if abs(real - claimed) > 0.05:
            fails.append(
                "%s:%d  a comment says %.2f:1 and %s measures %.2f:1.\n"
                "      A ratio in a comment is a second copy of a derivable "
                "number. This one was\n      copied from another stylesheet "
                "where it describes a different pair."
                % (name, line, claimed, pair, real))

    # ---- K. a ratio-shaped number in the document that no claim covers ----
    #
    # ROUND 6 FOUND THE LAST UNCHECKED RATIO BY HAND, WHICH IS NOT A METHOD.
    #
    # After the ratio tables landed, a manual sweep asked which ratio-shaped
    # numbers in DESIGN.md a claim actually covered, and found two that none
    # did: the historical pair in 2.5. That sweep was a person remembering to
    # look. Round 7 then added two more numbers to the file, and the same
    # question had to be asked again.
    #
    # So it is asked on every run. A gate's coverage is a property a gate can
    # measure about itself, and leaving it to a reviewer's memory is how the
    # count drifts back down the next time a section is reorganised.
    #
    # TWO THINGS ARE NOT CLAIMS, and calling them claims makes this check
    # useless rather than strict:
    #
    #   a THRESHOLD. "4.5:1 for body text" and "clears 4.5:1" name the bar AA
    #   sets, not a measurement of a pair. There is nothing to recompute; the
    #   number is 4.5 because WCAG says so.
    #
    #   a claim WRAPPED across lines. A sentence hard-wrapped between its ink
    #   and its ratio reports the ratio's line, and the claim reader reports
    #   the line the sentence starts on. Same claim, two line numbers.
    #
    # Both are recognised by shape rather than by a list of line numbers,
    # because a list is the thing this whole round is about.
    threshold = re.compile(r"(?:clears?|meets?|needs?|against the|at least|"
                           r"minimum of|AA[^.]{0,20})\s*$", re.I)
    claimed_lines = {line for _, _, _, line in ratios}
    # A wrapped claim covers the line it starts on and the lines it runs onto.
    for _, _, _, line in ratios:
        claimed_lines.add(line + 1)
        claimed_lines.add(line + 2)
    for m in re.finditer(r"(?<![\d.])(\d+\.\d+)\s*:\s*1", text):
        line = text[:m.start()].count("\n") + 1
        if line in claimed_lines:
            continue
        # The words immediately before the number decide what it is.
        head = text[max(0, m.start() - 90):m.start()]
        if threshold.search(head.replace("\n", " ")):
            continue
        fails.append(
            "%s:%d  states %s:1 and no claim in this gate covers it.\n"
            "      %s\n"
            "      Every ratio in this document is derivable from the shipped "
            "tokens, so an\n      unchecked one is a number that goes stale "
            "silently. Write it in a shape\n      this gate reads (`--ink` on "
            "`--surface` measures **N:1**, or a ratio table)."
            % (DOC, line, m.group(1),
               text.splitlines()[line - 1].strip()[:96]))

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
    print("ratio claims checked:      %d  in %s, %d more in stylesheet comments"
          % (len(ratios), DOC, len(css_ratios)))
    for name, line, claimed, real, pair in css_ratios:
        print("    %s:%-4d %5.2f:1  %-28s tree %5.2f" % (name, line, claimed,
                                                         pair, real))
    if css_historical:
        print("  stated in the past tense, about a value the tree no longer "
              "ships, not checked:")
        for name, line, claimed, clause in css_historical:
            print("    %s:%-4d %5.2f:1  %s" % (name, line, claimed, clause))
    if css_unresolved:
        print("  ratio-shaped numbers in a comment whose pair does not resolve:")
        for name, line, claimed, clause in css_unresolved:
            print("    %s:%-4d %5.2f:1  %s" % (name, line, claimed, clause))
        print("  These are NOT checked. Name both colours in the clause to "
              "check one.")
    print("colour literals read:      %d  across every html, js and css file"
          % len(lits))
    print("  %-24s %s"
          % ("by position:",
             "  ".join("%s %d" % (k, sum(1 for x in lits if x["kind"] == k))
                       for k in ("root", "paint", "alpha", "mask", "text"))))
    print("  %-24s %d  each recomputed against its token"
          % ("declared token copies:", sum(1 for x in paints if x["mirror"])))
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
