"""The token set, derived from the stylesheets and from DESIGN.md. Never a list.

WHY THIS FILE EXISTS

Round 5 of review found `DESIGN.md` documenting `--fg-3` as `#666B73` while
`base.css` had shipped `#7C828C` since August, and the paragraph underneath
reasoning from the stale value: it told a builder the token fails AA and
paints no characters on the flow screens, when the shipped value clears AA on
every surface and paints 268 character runs across the set. Five gates read
straight past a planted `#FF00FF` in that same row.

`verify_tokens.py` already held the right idea and the wrong scope. It carried
seven hardcoded literals and compared them against `base.css`, so it could
only ever notice a drift in those seven, and it never read the normative
document at all. That is the SCOPE-blind defect this tree has now paid for
five times: a rule enforced over a list cannot fail on the entry the list does
not mention.

So neither side of the comparison is written down here.

  * the SHIPPED set is every custom property every stylesheet in this
    directory defines, read from the stylesheets
  * the DOCUMENTED set is every token DESIGN.md gives a value to, read from
    the document's tables

A token added to a stylesheet next month is compared the day it exists, and a
row added to the document is checked against the tree the same way, with
nobody having to remember this file.

WHAT A GATE DOES WITH THEM: see verify_designmd.py. The three answers that
matter are a token in both that disagrees, a token documented that no
stylesheet defines, and a token shipped that no document mentions.

No browser and no server: these are source reads.
"""

import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))

# A CSS comment can hold a hex, a ratio, or a whole worked example. Every
# parse below strips comments first, because this tree's stylesheets carry
# their reasoning inline and a value quoted in prose is not a definition.
_COMMENT = re.compile(r"/\*.*?\*/", re.S)

# A custom property definition inside a rule block. The value runs to the
# semicolon; `--pane-shadow` holds two comma-separated shadows and has to
# survive intact.
_DEF = re.compile(r"(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);")


def stylesheets():
    """Every stylesheet in the directory. Derived, so a new layer joins."""
    return sorted(os.path.basename(p)
                  for p in glob.glob(os.path.join(HERE, "*.css")))


def _root_blocks(src):
    """The bodies of every `:root` rule in a stylesheet.

    Written as a brace scan rather than a regex. `re.search(r":root\\s*\\{(.*?)\\}")`
    is the obvious version and it is wrong twice over: non-greedy, it stops at
    the first closing brace, and a file with two `:root` blocks (base.css has
    exactly that) silently contributes only the first. That is how the pane
    surface system, seven tokens carrying the polished pass's whole look, was
    invisible to every reader of this tree including the round-5 audit probe.
    """
    out = []
    for m in re.finditer(r":root[^{]*\{", src):
        depth, i = 1, m.end()
        while i < len(src) and depth:
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
            i += 1
        out.append(src[m.end():i - 1])
    return out


def shipped():
    """Every custom property defined in a `:root` block, and where.

    Returns {token: (value, stylesheet)}. A token redefined in a later
    stylesheet reports the LAST definition, which is the one that wins in the
    cascade and therefore the one a person sees.
    """
    out = {}
    for name in stylesheets():
        src = _COMMENT.sub("", open(os.path.join(HERE, name), encoding="utf-8").read())
        for body in _root_blocks(src):
            for m in _DEF.finditer(body):
                out[m.group(1)] = (m.group(2).strip(), name)
    return out


# A row of a DESIGN.md table whose first cell is a token in backticks and
# whose second cell is a value in backticks. That shape is the document's own
# convention for "this token has this value", used by section 2.1, 2.4 and
# 3.1 alike, so reading the SHAPE finds a table added later for free.
_DOC_ROW = re.compile(r"^\|\s*`(--[a-zA-Z0-9-]+)`\s*\|\s*`([^`]+)`\s*\|", re.M)


def documented(doc="DESIGN.md"):
    """Every token DESIGN.md states a value for, and the line it says it on."""
    path = os.path.join(HERE, doc)
    text = open(path, encoding="utf-8").read()
    out = {}
    for m in _DOC_ROW.finditer(text):
        out[m.group(1)] = (m.group(2).strip(), text[:m.start()].count("\n") + 1)
    return out


def normalise(value):
    """Compare values by what they MEAN, not by how they were typed.

    `#7c828c` and `#7C828C` are the same colour, and so are `rgba(255,255,255,0.16)`
    and `rgba(255, 255, 255, 0.16)`. A gate that fails on whitespace teaches a
    reader to discount its output, which is how a real drift gets waved
    through.
    """
    v = " ".join(value.split())
    v = re.sub(r",\s*", ",", v)
    if re.fullmatch(r"#[0-9A-Fa-f]{3}", v):
        v = "#" + "".join(c * 2 for c in v[1:])
    if re.fullmatch(r"#[0-9A-Fa-f]{6}", v):
        return v.upper()
    return v


def as_rgb(value):
    """A token's colour as an (r, g, b) triple, or None if it is not one.

    Only opaque colours convert. An `rgba()` hairline has no single colour
    until it is composited over something, and guessing at that surface is
    the exact class of error verify_ink.py was written to delete.
    """
    v = normalise(value)
    if re.fullmatch(r"#[0-9A-F]{6}", v):
        return tuple(int(v[i:i + 2], 16) for i in (1, 3, 5))
    m = re.fullmatch(r"rgb\((\d+),(\d+),(\d+)\)", v)
    if m:
        return tuple(int(g) for g in m.groups())
    return None


def _channel(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def contrast(fg, bg):
    """WCAG 2.2 contrast ratio between two opaque (r, g, b) triples."""
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)
