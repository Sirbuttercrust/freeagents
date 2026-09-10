#!/usr/bin/env python3
"""Positive controls for round 7's colour-literal checks.

A gate written after a fix has never once seen the defect it claims to catch.
Green on a fixed tree proves the assertions run, not that they discriminate.
Each control below re-creates a round-7 defect in the exact shape it shipped
in, asserts the gate FAILS naming the right thing, reverts, and asserts PASS.

WHAT ROUND 7 WAS ABOUT, so the controls can be judged against it.

Section 2.1 states a rule about SCREENS: "no screen may introduce a hex value".
Twenty-three gates passed a tree where nine screens painted `#3A3A4A` into an
inline `<svg>`, because every gate read the rule in the direction it was easy
to check, walking `:root` blocks for token definitions. Nothing ever opened an
HTML file looking for a colour. Audit planted a `#D8D8D8` swatch chosen to
CLEAR AA, so no contrast gate could catch it for the wrong reason, and all 23
went green.

So control A is the audit's own plant, restored. If it ever stops failing, the
direction of 2.1 is unread again.

THE CONTROLS THAT MATTER MOST ARE THE ONES THAT MUST NOT FIRE.

Half of this suite plants things that are NOT defects: a pull request number
in a paragraph, an alpha over a surface, a stencil in a mask. Each is
colour-shaped and each is legal, and a checker that fails on them is worse
than no checker, because the first person who hits a false failure stops
reading the output. Those controls assert exit 0.

That half exists because the first version of round 7's CSS-comment ratio
reader guessed at which colours a claim was about and produced five confident
wrong failures against correct stylesheets. It was caught by running it, not
by reading it.

Run from the wireframe directory. Reverts on any exit, including SIGTERM.

    python3 verify_round7_mutation.py
"""
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mutationsafe                                             # noqa: E402

DOC = os.path.join(HERE, "DESIGN.md")
BASE = os.path.join(HERE, "base.css")
MARKET = os.path.join(HERE, "market.css")
POLISH = os.path.join(HERE, "polish.css")
SWARM = os.path.join(HERE, "swarm.js")
CONDUCT = os.path.join(HERE, "conduct.html")
DEPOSIT = os.path.join(HERE, "deposit.html")
FILES = [DOC, BASE, MARKET, POLISH, SWARM, CONDUCT, DEPOSIT]


def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def write(p, s):
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(s)


def digest(paths):
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(read(p).encode("utf-8"))
    return h.hexdigest()[:12]


def run_gate():
    p = subprocess.run([sys.executable, os.path.join(HERE, "verify_designmd.py")],
                       capture_output=True, text=True, cwd=HERE)
    return p.returncode, p.stdout + p.stderr


def sub(path, old, new):
    """Replace and PROVE the replacement landed.

    A mutation whose substring no longer matches silently mutates nothing, and
    the gate then passes for the only reason that does not count.
    """
    s = read(path)
    if old not in s:
        raise SystemExit("mutation target not found in %s:\n  %r"
                         % (os.path.basename(path), old[:90]))
    write(path, s.replace(old, new, 1))


# ---- A. the audit's own plant: a legible swatch on a screen ---------------
def mut_screen_hex():
    """`#D8D8D8` in conduct.html, chosen to clear AA at ~15:1.

    The defect under test is A SCREEN INTRODUCED A COLOUR, not a screen
    introduced an unreadable one. Every contrast gate in this directory is
    structurally unable to catch this, which is why 23 of them passed it.
    """
    sub(CONDUCT, "</main>", '<p style="color:#D8D8D8">planted swatch</p>\n</main>')


# ---- B. the defect as it really shipped: the flat disc, restored ----------
def mut_menu_disc():
    """The account-menu placeholder, in the exact markup it had on eight screens."""
    sub(DEPOSIT, '<span class="av" data-avatar=',
        '<svg viewBox="0 0 32 32" aria-hidden="true">'
        '<circle cx="16" cy="16" r="16" fill="#3A3A4A"/></svg>'
        '<span class="av" data-avatar=')


# ---- C. a colour typed into a stylesheet outside :root --------------------
def mut_css_literal():
    """The `--unverified-fg` defect, undone.

    Typed as `rgb()` rather than as a hex on purpose. A gate that only reads
    hex is answered by typing the same colour a different way, which is a
    list pretending to be a derivation.
    """
    sub(MARKET, "  color: var(--unverified-fg);", "  color: rgb(26, 18, 6);")


# ---- D. a renderer's copy of a token that no longer matches it ------------
def mut_stale_mirror():
    """`--accent` moves and swarm.js keeps reserving the old hue.

    This is a product defect, not a bookkeeping one: RESERVED holds the accent
    so a generated agent can never come out wearing the colour that means
    verified. If the copy goes stale the band guards a hue nothing uses and an
    agent can be generated in the reserved colour.
    """
    sub(BASE, "  --accent:    #7C7CFF;", "  --accent:    #6E6EF5;")


# ---- E. a renderer literal that silently equals a token ------------------
def mut_undeclared_mirror():
    """The same copy, with its annotation removed rather than its value."""
    sub(SWARM, 'var BG = "#08090A"; /* = --bg */', 'var BG = "#08090A";')


# ---- F. a stale ratio in a stylesheet comment ----------------------------
def mut_css_ratio():
    """D16, restored: the 8.85 that was copied from another stylesheet."""
    sub(MARKET, "Dark ink on a solid amber measures 8.34:1.",
        "Dark ink on a solid amber measures 8.85:1.")


# ---- G. a ratio in DESIGN.md that no claim covers ------------------------
def mut_uncovered_ratio():
    """A number written in a shape no claim reader parses.

    Round 6 found the last one of these by hand. A sentence that states a
    ratio without naming its pair cannot be recomputed, so it is unchecked
    from the day it is written and looks exactly like a checked one.
    """
    sub(DOC, "**Dark only.**",
        "The badge ink measures 9.12:1 in practice.\n\n**Dark only.**")


# ---- H. an exemption that outlives its subject ---------------------------
def mut_stale_exclusion():
    """A token removed from the tree while its written reason stays behind."""
    sub(POLISH, "  --dur-3: .38s;", "")


# ======================================================================
# THE CONTROLS THAT MUST NOT FIRE. Each plants something colour-shaped and
# LEGAL, and asserts the gate stays green. A checker that fails on these
# teaches a reader to discount its output, and then a real drift goes through.
# ======================================================================

# ---- N1. a pull request number in a paragraph ----------------------------
def mut_pr_number():
    """`#418` in running text is a pull request, and nine already exist.

    This is the reason the classification is by POSITION and not by value. A
    rule that reads "no hex-shaped string on a screen" fails this, and the
    tree would have to stop naming pull requests.
    """
    sub(CONDUCT, "</main>", "<p>Last merged acme/console#301</p>\n</main>")


# ---- N2. an alpha over whatever sits beneath it --------------------------
def mut_alpha_surface():
    """Section 2.6's whole recipe: a surface is an alpha, never a hex."""
    sub(POLISH, ".counter.is-over { color: var(--bad); }",
        ".counter.is-over { color: var(--bad); }\n"
        ".counter.is-near { background: rgba(255,255,255,0.06); }")


# ---- N3. a stencil in a mask declaration --------------------------------
def mut_mask_stencil():
    """Only the alpha channel of this black is used. Nothing renders it."""
    sub(MARKET, ".wrap-wide {",
        ".fadeprobe { -webkit-mask-image: linear-gradient(180deg, #000 10%, "
        "transparent 90%); }\n.wrap-wide {")


# ---- N4. a hue in the renderer's own colour space -----------------------
def mut_renderer_hue():
    """A thirteenth arcade hue is 2.4's business, not 2.1's.

    It is not a palette entry, it is a point in the space a generated creature
    is drawn from. The value chosen is deliberately far from every shipped
    token, so this control cannot pass by accidentally being a mirror.
    """
    sub(SWARM, '{ id: "rose",    deg: 338, base: "#FF3D82" }',
        '{ id: "rose",    deg: 338, base: "#FF3D82" },\n'
        '    { id: "coral",   deg: 350, base: "#FF6B4A" }')


MUTATIONS = [
    ("A  a legible swatch painted onto a screen", mut_screen_hex,
     "conduct.html", "which no token defines"),
    ("B  the flat account-menu disc, as it shipped", mut_menu_disc,
     "deposit.html", "paints `#3A3A4A`"),
    ("C  a colour typed into a rule, as rgb() not hex", mut_css_literal,
     "market.css", "paints `rgb(26, 18, 6)`"),
    ("D  a token moves and the renderer's copy does not", mut_stale_mirror,
     "swarm.js", "calls it `--accent`"),
    ("E  a renderer literal that silently equals a token", mut_undeclared_mirror,
     "swarm.js", "does not say so"),
    ("F  a stale ratio in a stylesheet comment", mut_css_ratio,
     "market.css", "a comment says 8.85:1"),
    ("G  a ratio in the document that no claim covers", mut_uncovered_ratio,
     "DESIGN.md", "no claim in this gate covers it"),
    ("H  an exemption outliving the token it excused", mut_stale_exclusion,
     "--dur-3", "no stylesheet defines any more"),
]

# (name, mutate, what it is) for the ones that must NOT fire.
NEGATIVES = [
    ("N1 a pull request number in a paragraph", mut_pr_number,
     "a text node, not paint"),
    ("N2 an alpha over the surface beneath it", mut_alpha_surface,
     "section 2.6's recipe, not a palette entry"),
    ("N3 a stencil inside a mask declaration", mut_mask_stencil,
     "an alpha channel written in colour syntax"),
    ("N4 a thirteenth hue in the renderer", mut_renderer_hue,
     "section 2.4's colour space, not 2.1's palette"),
]


def main():
    before = digest(FILES)
    saved = dict((p, read(p)) for p in FILES)

    mutationsafe.guard(FILES)
    mutationsafe.acquire(FILES)

    print("=" * 78)
    print("verify_round7_mutation.py   tree %s" % before)
    print("=" * 78)
    print("Each control re-creates a round-7 defect and asserts verify_designmd")
    print("FAILS naming the file and the reason. Exit 1 alone proves nothing: an")
    print("unrelated check could be failing, which is how a mutation passes for a")
    print("cause it was not written for.")
    print()
    print("The NEGATIVE controls plant something colour-shaped and LEGAL and")
    print("assert exit 0. A gate that cries wolf is retired by its first reader.")
    print()

    caught, missed, wrong_reason = 0, [], []
    clean, false_alarm = 0, []
    try:
        for name, mutate, token, expect in MUTATIONS:
            mutate()
            code, out = run_gate()
            # ONE LINE HAS TO CARRY BOTH, and this is not a cosmetic choice.
            # Asking whether the file and the reason appear anywhere in the
            # output passes when an unrelated check happens to print each of
            # them separately. The first draft of this suite did exactly that
            # and printed "base.css:38 3.72:1 Was #666B73" as its evidence for
            # a swatch planted in conduct.html: the word "which" matched a
            # sentence about a different defect entirely. A control whose
            # evidence is a line about something else is not a control.
            hit = [l.strip() for l in out.splitlines()
                   if token in l and expect in l]
            if code != 0 and hit:
                caught += 1
                print("  CAUGHT %-48s exit %d" % (name, code))
                print("         %s" % hit[0][:94])
            elif code != 0 and token in out:
                wrong_reason.append((name, "failed naming %s but no single "
                                     "line said %r" % (token, expect)))
                print("  WRONG REASON %-42s exit %d" % (name, code))
            elif code != 0:
                wrong_reason.append((name, "failed but never named %s" % token))
                print("  WRONG REASON %-42s exit %d" % (name, code))
            else:
                missed.append(name)
                print("  MISSED %-48s exit %d" % (name, code))
            for p, s in saved.items():
                write(p, s)

        print()
        for name, mutate, why in NEGATIVES:
            mutate()
            code, out = run_gate()
            if code == 0:
                clean += 1
                print("  QUIET  %-48s exit 0" % name)
                print("         %s" % why)
            else:
                bad = [l.strip() for l in out.splitlines()
                       if "paints" in l or "does not say so" in l
                       or "comment says" in l or "covers it" in l]
                false_alarm.append((name, bad[0][:90] if bad else "exit 1"))
                print("  FALSE ALARM %-43s exit %d" % (name, code))
                print("         %s" % (bad[0][:88] if bad else ""))
            for p, s in saved.items():
                write(p, s)
    finally:
        for p, s in saved.items():
            write(p, s)
        mutationsafe.release()

    after = digest(FILES)
    print()
    print("-" * 78)
    print("tree after revert: %s  %s"
          % (after, "IDENTICAL" if after == before else "DIFFERENT"))

    print("\nre-running verify_designmd on the reverted tree:")
    code, out = run_gate()
    checked = [l.strip() for l in out.splitlines()
               if l.startswith(("ratio claims", "colour literals",
                                "every shipped token"))
               or l.strip().startswith(("by position:", "declared token"))]
    print("  verify_designmd.py       exit %d  %s"
          % (code, "PASS" if code == 0 else "FAIL"))
    for c in checked:
        print("    %s" % c)

    ok = (not missed and not wrong_reason and not false_alarm
          and after == before and code == 0)
    print()
    if ok:
        print("MUTATION TEST PASSED: %d of %d defects caught naming the file and"
              % (caught, len(MUTATIONS)))
        print("the reason, %d of %d legal colours left alone, tree reverted"
              % (clean, len(NEGATIVES)))
        print("clean, the gate green after.")
        return 0
    for n in missed:
        print("  MISSED: %s" % n)
    for n, why in wrong_reason:
        print("  WRONG REASON: %s: %s" % (n, why))
    for n, why in false_alarm:
        print("  FALSE ALARM: %s: %s" % (n, why))
    if after != before:
        print("  TREE NOT RESTORED")
    print("\nMUTATION TEST FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
