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

_JS_LINE_COMMENT = re.compile(r"//[^\n]*")
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)

# THE VOCABULARY, and why it is this wide.
#
# Round 8 planted eight colours on a screen and round 7's reader saw one. Four
# of the misses were spelling: `#D8D8D8FF`, `#D8DF`, `oklch(...)` and
# `rgb(216 216 218)` are the same paint as `#D8D8D8` and every browser this
# tree targets renders all of them. A rule about hex values is a rule about
# one spelling, and a person who wants the colour writes it another way
# without ever meaning to evade anything.
#
# A NAMED KEYWORD IS THE HARD ONE and it decides the shape of this module.
# `red` in a `fill` is paint. `white` in `white-space: nowrap` is half a
# property name, and this tree ships nine of those. No amount of widening the
# pattern separates them, because the difference is not in the characters. It
# is in whether the run is a VALUE. So the vocabulary can only widen once the
# reader parses declarations, which is the same fix the mask window needed.
_NAMED = (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black "
    "blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse "
    "chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan "
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta "
    "darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen "
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet "
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite "
    "forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green "
    "greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender "
    "lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan "
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink "
    "lightsalmon lightseagreen lightskyblue lightslategray lightslategrey "
    "lightsteelblue lightyellow lime limegreen linen magenta maroon "
    "mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen "
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred "
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace "
    "olive olivedrab orange orangered orchid palegoldenrod palegreen "
    "paleturquoise palevioletred papayawhip peachpuff peru pink plum "
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown "
    "salmon sandybrown seagreen seashell sienna silver skyblue slateblue "
    "slategray slategrey snow springgreen steelblue tan teal thistle tomato "
    "turquoise violet wheat white whitesmoke yellow yellowgreen").split()

_COLOUR = re.compile(
    r"#[0-9A-Fa-f]{8}\b|#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{4}\b|#[0-9A-Fa-f]{3}\b|"
    r"\brgba?\([^)]*\)|\bhsla?\([^)]*\)|"
    r"\b(?:oklch|oklab|lab|lch|hwb|color)\([^)]*\)|"
    r"\b(?:" + "|".join(_NAMED) + r")\b(?![-\w])")

# `currentColor` and `transparent` are colour keywords that introduce nothing:
# one takes the ink of the text around it, the other paints no pixels. The
# icon sprite uses `currentColor` throughout, which is the opposite of a
# screen introducing a colour.
_NO_PAINT = {"currentcolor", "transparent", "inherit", "initial", "unset",
             "none", "revert"}

# A property whose value is a stencil rather than paint. `mask-image:
# linear-gradient(#000 0 0)` uses the alpha channel of a black gradient to cut
# a shape; nothing renders that black.
_MASK_PROP = re.compile(r"\A-?(?:webkit-|moz-|ms-)?mask(?:-[a-z]+)*\Z")

# The SVG presentation attributes and the CSS properties that put a colour on
# screen. A custom property counts: `--id-hue` set in a style attribute is
# read by market.css and painted on the identity band, the avatar ring and the
# card rim, so a literal there is the identity colour introduced on a screen
# with one level of indirection.
_PAINT_PROP = re.compile(
    r"\A(?:--[\w-]+|fill|stroke|stop-color|flood-color|lighting-color|color|"
    r"background|background-color|background-image|border[\w-]*color|border|"
    r"box-shadow|text-shadow|text-decoration-color|caret-color|column-rule|"
    r"column-rule-color|outline|outline-color|accent-color|text-emphasis-color|"
    r"-webkit-text-fill-color|-webkit-text-stroke-color|filter|backdrop-filter)\Z",
    re.I)


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
    m = re.match(r"(?:rgba|hsla)\([^)]*?[,/]\s*([\d.]+)%?\s*\)$", value.strip())
    return float(m.group(1)) if m else 1.0


_URL_FN = re.compile(r"url\([^)]*\)")
_CSS_STRING = re.compile(r"\"[^\"\n]*\"|'[^'\n]*'")


def _css_blank(src):
    """Blank `url()` contents and quoted strings in CSS, keeping offsets.

    `url(white.png)` is a file name and `content: "red"` is a character. Both
    sit inside the value of a real paint property, so once the vocabulary
    knows the named colours, a scan that reads them condemns correct code:
    round 8's own negative control planted `background-image: url(white.png)`
    and the first version of this fix reported it as a screen painting
    `white`. Blanking here rather than only inside the declaration parser
    means the colour scan and the property scan see the same text.
    """
    return _blank(_blank(src, _URL_FN), _CSS_STRING)


def _css_declarations(src):
    """Every `property: value` in CSS source, as (name, value_start, value_end).

    WHY THIS REPLACED A CHARACTER WINDOW. Round 7 decided what owned a colour
    by reading the 120 characters in front of it. That is a guess about where
    a property name lives, and a long value answers it. Two mask declarations
    identical in kind were classified differently purely by length:

        property to colour   57 chars   stencil, exempt
        property to colour  183 chars   PAINT, gate failed

    A verdict that turns on how many gradient stops somebody wrote is not
    reading a position. The scan below walks braces, so the property name is
    read rather than guessed, and a declaration may be any length.

    Strings and `url()` contents are blanked first: `url(white.png)` is a file
    name and `content: "red"` is a character, and both would otherwise enter
    the value as a colour word the moment the vocabulary widened.
    """
    src = _css_blank(src)
    out, i, n = [], 0, len(src)
    while i < n:
        ch = src[i]
        if ch in "{};":
            i += 1
            continue
        # A property name runs to the next colon, and cannot contain a brace.
        j = i
        while j < n and src[j] not in ":{};":
            j += 1
        if j >= n or src[j] != ":":
            i = j + 1
            continue
        name = src[i:j].strip()
        # Everything after a selector, an at-rule or a pseudo-class is not a
        # declaration. A property name is one identifier.
        k, depth = j + 1, 0
        while k < n:
            c = src[k]
            if c == "(":
                depth += 1
            elif c == ")":
                depth = max(0, depth - 1)
            elif depth == 0 and c in ";}{":
                break
            k += 1
        if re.fullmatch(r"-?-?[a-zA-Z][\w-]*", name):
            out.append((name, j + 1, k))
        i = k + 1 if k < n and src[k] == ";" else k
    return out


def _html_attributes(src):
    """Every `name="value"` inside a tag, as (name, value_start, value_end).

    Reads tags rather than looking backwards from the value, for the same
    reason as the CSS scan: `#4471` in `href="#4471"` and `#4471` in a
    paragraph are both "not paint", and a window cannot tell either of them
    from a `fill=`.
    """
    out = []
    for tag in re.finditer(r"<[a-zA-Z][^>]*>", src, re.S):
        body = tag.group(0)
        base = tag.start()
        for m in re.finditer(r"([:\w-]+)\s*=\s*(\"[^\"]*\"|'[^']*')", body):
            out.append((m.group(1), base + m.start(2) + 1,
                        base + m.end(2) - 1))
    return out


# The property a script is assigning, read from the text IMMEDIATELY before a
# value. Each pattern is anchored with `$`, so it matches adjacency rather
# than proximity: an object key, a style assignment, a `setProperty` or a
# `setAttribute` sits against its value or it is not that value's property.
# Same shape as `_MIRROR`, which is anchored with `\A` for the same reason.
#
# WHY A SCRIPT NEEDS THIS AT ALL. A bare colour NAME in a script is usually
# not a colour: `swarm.js` holds `{ id: "red", deg: 0, base: "#FF2D2D" }`,
# where `red` is the hue's IDENTIFIER and the colour is the hex beside it.
# Counting that word as paint puts nine false entries in the population, and
# the day the renderer exemption moves they become nine false failures. The
# discriminator is the same one the CSS scan uses: `id:` is not a paint
# property and `fill:` is.
_JS_PROP = [
    re.compile(r"([A-Za-z_$][\w$-]*)\s*:\s*$"),
    re.compile(r"\.style\.([A-Za-z][\w]*)\s*=\s*$"),
    re.compile(r"setProperty\(\s*[\"']([\w-]+)[\"']\s*,\s*$"),
    re.compile(r"setAttribute\(\s*[\"']([\w-]+)[\"']\s*,\s*$"),
]


def _js_property(src, start):
    """The property name a script literal is the value of, or None."""
    before = src[max(0, start - 64):start].rstrip("\"'")
    for rx in _JS_PROP:
        m = rx.search(before)
        if m:
            return m.group(1)
    return None




def renderers(doc="DESIGN.md"):
    """The files DESIGN.md 2.1 declares as the generative renderer's space.

    READ FROM THE DOCUMENT, not hardcoded here, and that is the whole point.
    2.1's position table names three scripts whose literals are section 2.4's
    subject rather than 2.1's: they are points in a colour space a creature is
    generated from, not palette entries. Round 7's gate exempted EVERY script
    instead, so the document said three files and the instrument meant seven,
    and `polish.js` could paint an `h1` on all 33 screens with the suite green.

    Two things follow from reading it here. A fourth renderer added to the
    document is exempt the day it is written down, and a renderer REMOVED from
    the document immediately fails on its own literals, which is what makes
    the exemption checkable rather than a hole with a comment over it.
    """
    text = open(os.path.join(HERE, doc), encoding="utf-8").read()
    row = re.search(r"^\|\s*a literal in ([^|]+)\|", text, re.M)
    if not row:
        return set()
    return set(re.findall(r"`([a-z_0-9]+\.js)`", row.group(1)))


def _html_style_spans(src):
    """The contents of every `<style>` element, as (start, end) offsets.

    A page-local `<style>` block is CSS that the browser applies to that
    screen, and every one of the 33 screens has one. Round 7 read an HTML file
    as markup and text nodes only, so a colour typed in a page's own style
    block was classified as a TEXT NODE and waved through: the largest unread
    surface in the tree, and the one place a page-specific component actually
    gets styled.
    """
    return [(m.start(1), m.end(1)) for m in
            re.finditer(r"<style\b[^>]*>(.*?)</style>", src, re.S | re.I)]


def literals():
    """Every colour literal a browser loads, outside `:root`, with its class.

    Returns a list of dicts: file, line, value, kind, context.

    The six kinds, and the rule that owns each:

      root      a token definition. `shipped()`'s subject, skipped here
      mask      a stencil in a mask declaration. Renders nothing
      alpha     a translucent value. Section 2.6: a surface is an alpha over
                whatever sits beneath it, never a hex, so it has no single
                colour and cannot be a palette entry
      text      a colour-shaped run that is not the value of a paint property
                or attribute. `#418` in a paragraph is a pull request, `#4471`
                in an `href` is a fragment, and `white` in `white-space` is
                half a property name. Excluded by POSITION, never by value
      keyword   `currentColor`, `transparent`. A colour keyword that
                introduces no colour: one takes the ink around it, the other
                paints nothing
      paint     an opaque colour a person sees. Section 2.1's subject

    A `paint` also carries `mirror`: the token it declares itself a copy of,
    read from a `/* = --token */` comment after the value.

    POSITION IS READ, NOT GUESSED. Round 7 classified by looking back 120
    characters from the value. Both directions of that are wrong: a long value
    pushed its own property out of the window, and a paragraph could not be
    told from an attribute. CSS declarations and HTML attributes are parsed
    now, so `fill="red"` is paint, `white-space: nowrap` is not a colour at
    all, and a mask with eight gradient stops is the same stencil as a mask
    with two.
    """
    out = []
    for name in sorted(os.path.basename(p) for p in
                       glob.glob(os.path.join(HERE, "*.html"))
                       + glob.glob(os.path.join(HERE, "*.js"))
                       + glob.glob(os.path.join(HERE, "*.css"))):
        raw = open(os.path.join(HERE, name), encoding="utf-8").read()
        if name.endswith(".css"):
            src = _css_blank(_blank(raw, _COMMENT))
            roots = [(a, c) for a, _, c in _root_spans(src)]
            decls = _css_declarations(src)
            attrs = []
        elif name.endswith(".js"):
            src = _blank(_blank(raw, _COMMENT), _JS_LINE_COMMENT)
            roots, decls, attrs = [], [], []
        else:
            # `url()` contents are blanked in HTML too, since a page's own
            # <style> block is CSS. Quoted strings are NOT: an HTML attribute
            # value is quoted, so blanking those would erase `fill="red"`,
            # which is the thing this scan exists to read.
            src = _blank(_blank(_blank(raw, _HTML_COMMENT), _COMMENT), _URL_FN)
            roots = [(a, c) for a, _, c in _root_spans(src)]
            attrs = _html_attributes(src)
            # A style attribute holds declarations, and so does every page's
            # own <style> block. Both are CSS and both are read as CSS.
            decls = []
            for prop, vs, ve in attrs:
                if prop.lower() == "style":
                    decls += [(p, vs + a, vs + b) for p, a, b
                              in _css_declarations(src[vs:ve])]
            for ss, se in _html_style_spans(src):
                decls += [(p, ss + a, ss + b) for p, a, b
                          in _css_declarations(src[ss:se])]
                roots += [(ss + a, ss + c) for a, _, c
                          in _root_spans(src[ss:se])]
        lines = raw.splitlines()
        for m in _COLOUR.finditer(src):
            off = m.start()
            prop = next((p for p, a, b in decls if a <= off < b), None)
            if prop is None:
                prop = next((p for p, a, b in attrs if a <= off < b), None)
            if any(a <= off < b for a, b in roots):
                kind = "root"
            elif m.group(0).lower() in _NO_PAINT:
                kind = "keyword"
            elif name.endswith(".js"):
                # A bare colour WORD in a script is a name unless it sits in a
                # paint position. `{ id: "red", base: "#FF2D2D" }` holds one
                # colour and one identifier, and nine of those would otherwise
                # enter the population as paint.
                prop = _js_property(src, off)
                if (re.fullmatch(r"[a-z]+", m.group(0))
                        and not (prop and _PAINT_PROP.match(prop))):
                    kind = "text"
                elif _alpha_of(m.group(0)) < 1.0:
                    kind = "alpha"
                else:
                    kind = "paint"
            elif prop is None:
                kind = "text"
            elif _MASK_PROP.match(prop.lower()):
                kind = "mask"
            elif not _PAINT_PROP.match(prop):
                kind = "text"
            elif _alpha_of(m.group(0)) < 1.0:
                kind = "alpha"
            else:
                kind = "paint"
            line = src[:off].count("\n") + 1
            # The mirror comment is read from the RAW source, past the closing
            # quote, because the blanked copy has every comment erased.
            after = raw[m.end():m.end() + 60].lstrip("\"'")
            mm = _MIRROR.match(after)
            out.append({"file": name, "line": line, "value": m.group(0),
                        "kind": kind, "prop": prop,
                        "mirror": mm.group(1) if mm else None,
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
