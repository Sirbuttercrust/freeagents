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


def _root_spans(src):
    """Every `:root` rule as (rule_start, body_start, end) over the source.

    Written as a brace scan rather than a regex. `re.search(r":root\\s*\\{(.*?)\\}")`
    is the obvious version and it is wrong twice over: non-greedy, it stops at
    the first closing brace, and a file with two `:root` blocks (base.css has
    exactly that) silently contributes only the first. That is how the pane
    surface system, seven tokens carrying the polished pass's whole look, was
    invisible to every reader of this tree including the round-5 audit probe.

    One scan, used by both directions of section 2.1: `shipped()` reads the
    bodies, `literals()` uses the spans to know what is NOT a definition. Two
    copies of a brace walker would answer the same question differently the
    first time either one is fixed.
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
        out.append((m.start(), m.end(), i))
    return out


def _root_blocks(src):
    """The bodies of every `:root` rule in a stylesheet."""
    return [src[body:end - 1] for _, body, end in _root_spans(src)]


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


# ---------------------------------------------------------------- literals
#
# THE OTHER DIRECTION OF SECTION 2.1.
#
# `shipped()` above reads the token definitions. That answers "what colours
# does the product have", and every gate in this directory was built on it.
# Section 2.1 states a second rule pointing the opposite way:
#
#     No screen may introduce a hex value. A colour that is not in this
#     table does not exist in the product.
#
# Nothing read that direction. Twenty-three gates passed a tree in which nine
# screens painted `#3A3A4A` into an inline `<svg>`, because a gate that walks
# `:root` blocks cannot see a colour that was never defined as a token. The
# rule was enforced over the population that obeys it.
#
# So the population is derived here, from every file a browser loads, and the
# classification is by the POSITION a colour sits in rather than by its value.
# Position is the thing that decides whether a rule about screens applies:
# `#418` in a paragraph is a pull request number and `#418` in a `fill=` is
# paint, and no list of values can tell them apart.

_JS_LINE_COMMENT = re.compile(r"^[ \t]*//[^\n]*$", re.M)
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)

# Hex, rgb/rgba and hsl/hsla alike. A rule that only reads hex is answered by
# typing the same colour a different way, which is a list pretending to be a
# derivation.
_COLOUR = re.compile(
    r"#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b|"
    r"rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+[^)]*\)|"
    r"hsla?\([^)]*\)")

# A colour inside one of these declarations is a stencil. `mask-image:
# linear-gradient(#000 0 0)` uses the alpha channel of a black gradient to
# cut a shape; nothing renders that black, and calling it a palette entry
# would bury the twelve colours the rule is about.
_MASK_DECL = re.compile(r"(?:-webkit-)?mask(?:-image|-composite)?\s*:[^;{}]*$")

# The attributes and properties that put a colour on screen in HTML. A colour
# anywhere else in an HTML file is a text node.
_PAINT_ATTR = re.compile(
    r"(?:fill|stroke|stop-color|flood-color|lighting-color|color|"
    r"background(?:-color)?|border(?:-[a-z]+)?-color|box-shadow|"
    r"text-shadow|outline(?:-color)?)\s*[:=]\s*[\"']?[^\"'<>;]*$", re.I)


# A literal in a renderer may declare itself a MIRROR of a token by naming it
# in a comment immediately after the value: `var BG = "#08090A"; /* = --bg */`.
#
# WHY AN ANNOTATION AND NOT A LIST IN THE GATE. `swarm.js` holds `RESERVED =
# { hex: "#7C7CFF" }`, a copy of `--accent`, used to keep a hue band empty so
# a generated agent can never come out wearing the colour that means verified.
# Move `--accent` and the guard still reserves the old hue: the product breaks
# its own rule and every gate stays green. The annotation puts the claim where
# the value is, and the gate recomputes it, so the two cannot drift apart.
_MIRROR = re.compile(r"\A\s*(?:;|,|\))?\s*/\*\s*=\s*(--[a-zA-Z0-9-]+)\s*\*/")


def _blank(src, rx):
    """Blank out matches, keeping every offset and newline where it was.

    Deleting comments shifts every line number after them, and a gate that
    reports the wrong line teaches a reader to stop trusting its output.
    """
    return rx.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), src)


def _alpha_of(value):
    """The alpha of a colour literal, or 1.0 for an opaque one."""
    m = re.match(r"(?:rgba|hsla)\([^)]*?([\d.]+)\s*\)$", value.strip())
    return float(m.group(1)) if m else 1.0


def literals():
    """Every colour literal a browser loads, outside `:root`, with its class.

    Returns a list of dicts: file, line, value, kind, context.

    The five kinds, and the rule that owns each:

      root      a token definition. `shipped()`'s subject, skipped here
      mask      a stencil in a mask declaration. Renders nothing
      alpha     a translucent value. Section 2.6: a surface is an alpha over
                whatever sits beneath it, never a hex, so it has no single
                colour and cannot be a palette entry
      text      a colour-shaped run in an HTML text node. `#418` is a pull
                request. Excluded by POSITION, never by value
      paint     an opaque colour a person sees. Section 2.1's subject

    A `paint` in a script also carries `mirror`: the token it declares itself
    a copy of, read from a `/* = --token */` comment after the value.
    """
    out = []
    for name in sorted(os.path.basename(p) for p in
                       glob.glob(os.path.join(HERE, "*.html"))
                       + glob.glob(os.path.join(HERE, "*.js"))
                       + glob.glob(os.path.join(HERE, "*.css"))):
        raw = open(os.path.join(HERE, name), encoding="utf-8").read()
        if name.endswith(".css"):
            src = _blank(raw, _COMMENT)
            spans = [(a, c) for a, _, c in _root_spans(src)]
        elif name.endswith(".js"):
            src = _blank(_blank(raw, _COMMENT), _JS_LINE_COMMENT)
            spans = []
        else:
            src = _blank(_blank(raw, _HTML_COMMENT), _COMMENT)
            spans = []
        lines = raw.splitlines()
        for m in _COLOUR.finditer(src):
            if any(a <= m.start() < b for a, b in spans):
                kind = "root"
            else:
                before = src[max(0, m.start() - 120):m.start()]
                if name.endswith(".css") and _MASK_DECL.search(before):
                    kind = "mask"
                elif name.endswith(".html") and not _PAINT_ATTR.search(before):
                    kind = "text"
                elif _alpha_of(m.group(0)) < 1.0:
                    kind = "alpha"
                else:
                    kind = "paint"
            line = src[:m.start()].count("\n") + 1
            # The mirror comment is read from the RAW source, past the closing
            # quote, because the blanked copy has every comment erased.
            after = raw[m.end():m.end() + 60].lstrip("\"'")
            mm = _MIRROR.match(after)
            out.append({"file": name, "line": line, "value": m.group(0),
                        "kind": kind, "mirror": mm.group(1) if mm else None,
                        "context": lines[line - 1].strip()[:110]})
    return out


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
