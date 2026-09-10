#!/usr/bin/env python3
"""No gate may name its own screens. The scope of every assertion is derived.

WHY THIS GATE EXISTS

Four review rounds found the same defect wearing four different shapes, and
the fourth is the reason this file is here:

  round 1  a probe read one axis            AXIS-blind      13 real failures
  round 2  a probe read `a,button` only     SELECTOR-blind  12 real failures
  round 3  no probe opened a drawer         STATE-blind     12 real failures
  round 4  verify_ink.py named 8 screens    SCOPE-blind     25 screens never
                                                            measured at all

Each time, the fix landed on the instance the reviewer named. Each time, the
same defect was already sitting somewhere else in the tree wearing different
clothes, and the next round found it.

Round 4's fix could have been "add twenty-five names to that list". That
would have been the same mistake again, because the defect is not the length
of the list. It is that a LIST cannot fail. A screen added next month is not
in it, and the gate table goes on asserting a property of the whole set while
the new screen has never been opened.

WHAT THIS CHECKS

`population.py` provides the derivations. This gate makes using them
compulsory: every gate's SCREENS must be computed at run time from the
directory, never written as a literal list of file names.

The one thing that made round 4 invisible was that a narrow scope and a
correct scope produce identical output. `verify_mobile_coverage.py` already
closes that hole for the 320px sweep. This closes it for every gate at once,
including gates nobody has written yet.

No browser and no server: this reads source.

    python3 verify_coverage.py
"""

import ast
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import population                                             # noqa: E402

# Files that are instruments rather than gates. The mutation suites carry
# lists of the exact screens they plant a control in, which is the point of
# them: a mutation is aimed at one known place.
NOT_GATES = {
    "verify_all.py": "the runner, it has a gate list rather than a screen list",
    "verify_coverage.py": "this file",
    "verify_flow_mutation.py": "a mutation suite: it names the screen it plants in",
    "verify_round2_mutation.py": "a mutation suite: it names the screen it plants in",
    "verify_round3_mutation.py": "a mutation suite: it names the screen it plants in",
    "verify_contrast.py": "superseded, exits 2",
}

# A gate may name screens ONLY where the name carries a reason that a
# derivation cannot express, and the reason has to be here where a reviewer
# reads it rather than in a comment nobody opens.
#
# THE DISTINCTION THAT MATTERS: a SCOPE decision (which screens does this
# assertion apply to) must be derived, because a name silently omits a screen
# added later. A SEMANTIC map (what does this particular page mean) is a fact
# about that page and cannot be derived from the directory at all. An
# exemption belongs here; a population never does.
NAMED_WITH_REASON = {
    ("verify_polish.py", "SUPERSEDED"):
        "criteria.html and confirm.html are retired pages kept so an old "
        "link lands somewhere honest. Their controls are inert BECAUSE they "
        "are retired, so the live-control audit skips them by name. They are "
        "still swept for polish, contrast and 320px like every other screen.",
    ("population.py", "FLOW_LAYOUT_IN_PAGE"):
        "hire.html and agreement.html carry the payment flow's layout in a "
        "page-local style block rather than in flow.css, so a stylesheet "
        "derivation alone under-counts the flow by exactly these two.",
    ("verify_linknames.py", "IDENTITY"):
        "a MAP, not a population: which selector on each destination page "
        "holds the name that page calls itself. Only a profile page has one, "
        "and which element carries it is a fact about that page's markup.",
    ("verify_linknames.py", "EXCUSED"):
        "conduct.html shows one account acting as BOTH buyer and operator, "
        "which is that screen's subject. An exemption is a judgement about "
        "one page and has to be written down where it can be argued with.",
    ("verify_sitemap.py", "KNOWN"):
        "a MAP, not a population: which SITEMAP page id belongs to which "
        "file, for the pages whose section says 'Built.' with no filename or "
        "whose filename is not derivable from the title. Which id names which "
        "page is a fact about the document, unreadable from the directory, "
        "and the gate already fails on any served page missing from it, so a "
        "screen added later cannot hide behind this dict.",
    ("verify_sitemap.py", "SUPERSEDED"):
        "confirm.html and criteria.html carry a visible replaced-by banner "
        "and are excluded from the reachability sweep on purpose. Which "
        "pages are retired is a design decision, not a property of the "
        "directory.",
}

# ROUND 5's exemption table, and it is deliberately separate from the one
# above. NAMED_WITH_REASON excuses a screen name in a LIST; this excuses a
# screen name written INLINE, in a goto, a URL or a message.
#
# The same distinction governs both: a SCOPE decision (which screens does this
# assertion apply to) must be derived, because a name silently omits a screen
# added later. A SEMANTIC fact about one page cannot be derived at all.
INLINE_WITH_REASON = {
    "verify_links.py": {
        # index.html is the site root, not a member of a population: this gate
        # asks which pages are reachable FROM it, so the entry point is the
        # question rather than part of the answer.
        "index.html",
    },
    "verify_flow_mutation.py": {"staged.html"},
    "verify_round2_mutation.py": {"deposit.html", "agreement.html"},
    "verify_round3_mutation.py": {"browse.html", "settings.html",
                                  "notfound.html"},
    "verify_round4_mutation.py": {"browse.html", "agreement.html",
                                  "zz_ghost_screen.html"},
    # A mutation suite plants a defect in a specific file and asserts the gate
    # names THAT file. The screen is the fixture, not a population: round 7's
    # controls put a legible swatch in conduct.html and restore the flat
    # account-menu disc in deposit.html, and both assertions are about the
    # gate's output naming the file it was planted in. Deriving the fixture
    # would mean planting a defect in a page chosen at run time and then not
    # knowing which name to expect.
    "verify_round7_mutation.py": {"conduct.html", "deposit.html"},
}


def _is_screen(v):
    """A real screen NAME, not the string '.html' and not a glob.

    An extension constant is a file-type test, not a scope decision, and
    calling one a named screen list is the kind of noise that gets a gate
    switched off. Same for a glob: "*.html" passed to glob.glob IS the
    derivation this gate wants, so reading it as a named screen would fail
    every correctly written gate in the directory.

    THE NAME HAS TO BE A FILE THAT EXISTS. That is what separates a scope
    decision from a string that merely ends in .html, and it is the check
    this function's first version claimed in its docstring without making.
    """
    if not isinstance(v, str) or not v.endswith(".html"):
        return False
    if len(v) <= len(".html"):
        return False
    if "*" in v or "?" in v or "/" in v.strip("/"):
        return False
    return os.path.exists(os.path.join(HERE, v.lstrip("/")))


def _binds_screens(path):
    """Does this file ASSIGN a name containing SCREENS, at module level?

    A SUBSTRING SEARCH IS NOT A BINDING TEST, and this line used to be
    `"SCREENS" in src`. Two round-7 files failed it for writing the word in
    prose: verify_designmd.py explains that "2.1's sentence is about SCREENS",
    and verify_round7_mutation.py quotes the same rule in its docstring. Both
    were reported as holding a hardcoded screen list. Neither has a list of
    any kind.

    That is this gate's own subject in miniature. A gate that reads for a
    STRING where it means a STRUCTURE fails on a file that merely talks about
    the thing, and the fix is the same one this file already applies to every
    other question it asks: parse it. `literal_lists` above walks the AST.
    """
    tree = ast.parse(open(path, encoding="utf-8").read())
    for node in ast.walk(tree):
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            targets = [node.target]
        for t in targets:
            if isinstance(t, ast.Name) and "SCREENS" in t.id:
                return True
    return False


def literal_lists(path):
    """Module-level assignments whose value is a literal list of .html names."""
    tree = ast.parse(open(path, encoding="utf-8").read())
    out = []
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            try:
                val = ast.literal_eval(node.value)
            except Exception:
                continue                       # computed, which is the point
            names = []
            if isinstance(val, (list, tuple, set)):
                names = [v for v in val if _is_screen(v)]
                # A LIST OF TUPLES IS STILL A LIST OF SCREENS. verify_pickers
                # held [("staged.html", sel, label), ...] and this function
                # returned nothing for it, so the gate table printed "no
                # screen loop" over a hardcoded population of two. Round 5.
                for item in (val if isinstance(val, (list, tuple, set)) else []):
                    if isinstance(item, (list, tuple)):
                        names += [v for v in item if _is_screen(v)]
            elif isinstance(val, dict):
                names = [k for k in val if _is_screen(k)]
                names += [v for v in val.values() if _is_screen(v)]
            if names:
                out.append((target.id, sorted(set(names)), node.lineno))
    return out


def inline_screen_names(path):
    """Screen names written ANYWHERE in the file, outside a literal list.

    ROUND 5 OF THE SAME DEFECT, and the reason this function exists beside
    the one above.

    verify_coverage was written to fail a gate whose SCREENS is a literal
    list. Four gates then passed it while measuring a hardcoded page each,
    because they never bound a list at all: the page was written inline in
    the call that loads it.

        b.goto(BASE + "/deposit.html")          verify_rail
        b.goto(BASE + "/agreement.html")        verify_blast_preview
        URL = BASE + "dashboard.html"           verify_flow_motion
        PICKERS = [("staged.html", ...)]        verify_pickers

    Every one printed "no screen loop" in the coverage table, which reads as
    "this gate has no population to derive" and actually meant "this gate's
    population is one name nobody can see". A gate that measures the wrong
    single screen after a page is renamed fails loudly; a gate that measures
    a screen that still exists while a second screen grows the same component
    stays green forever. That is the hole.

    So the scope test is now the whole ast rather than the assignment list:
    a screen NAME in a gate is a scope decision wherever it is written.
    Docstrings and comments are exempt because they are prose, not scope.
    """
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)

    # Docstrings are prose: a gate is allowed to SAY which page it was written
    # for. Collect their line spans so the walk below can skip them.
    doc_lines = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.ClassDef)):
            body = getattr(node, "body", [])
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                d = body[0].value
                for ln in range(d.lineno, getattr(d, "end_lineno", d.lineno) + 1):
                    doc_lines.add(ln)

    # Names inside a literal list are already reported by literal_lists, so
    # they are not double-counted here.
    in_lists = set()
    for _, names, _ in literal_lists(path):
        in_lists.update(names)

    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        v = node.value
        if not _is_screen(v):
            continue
        if node.lineno in doc_lines:
            continue
        if v in in_lists:
            continue
        out.append((v, node.lineno))
    return sorted(set(out))


def main():
    on_disk = population.every_screen()
    gates = sorted(os.path.basename(p)
                   for p in glob.glob(os.path.join(HERE, "verify_*.py")))

    fails, rows, excused = [], [], []
    for name in gates:
        if name in NOT_GATES:
            continue
        for var, names, lineno in literal_lists(os.path.join(HERE, name)):
            key = (name, var)
            if key in NAMED_WITH_REASON:
                excused.append((name, var, len(names)))
                continue
            fails.append(
                "%s:%d  %s is a literal list of %d screen name(s).\n"
                "      %s\n"
                "      Derive it: population.every_screen(), "
                "population.screens_with_source(...), or add it to\n"
                "      NAMED_WITH_REASON in this file WITH the reason."
                % (name, lineno, var, len(names), " ".join(names[:6])
                   + (" ..." if len(names) > 6 else "")))

        # ROUND 5. A screen name written inline is the same scope decision as
        # a screen name in a list, and it was invisible to the check above.
        inline = inline_screen_names(os.path.join(HERE, name))
        allowed = INLINE_WITH_REASON.get(name, set())
        offending = [(v, ln) for v, ln in inline if v not in allowed]
        if offending:
            where = ", ".join("%s:%d" % (v, ln) for v, ln in offending[:6])
            fails.append(
                "%s  names %d screen(s) inline, outside any list: %s\n"
                "      A page written into a goto or a URL is a population of\n"
                "      one that nothing can see. Derive it with\n"
                "      population.screens_with_source(<markup it needs>), or\n"
                "      add it to INLINE_WITH_REASON WITH the reason."
                % (name, len(offending), where))
        elif inline:
            excused.append((name, "inline", len(inline)))

    # And the derivations themselves have to still cover the directory. A
    # partition that drifts is the same hole arriving by another road.
    pay = set(population.payment_screens())
    gen = set(population.general_screens())
    if pay | gen != set(on_disk):
        missing = sorted(set(on_disk) - (pay | gen))
        fails.append("population's partition misses %d screen(s): %s"
                     % (len(missing), " ".join(missing)))
    if pay & gen:
        fails.append("population's partition overlaps: %s"
                     % " ".join(sorted(pay & gen)))

    # WF_ONLY exists so the mutation suite can plant a defect on one screen
    # and see it without paying for a 33-screen sweep. It is also a switch
    # that silently narrows a gate, which is this round's defect with a
    # different name, so it is refused anywhere except a mutation run.
    if os.environ.get("WF_ONLY"):
        fails.append(
            "WF_ONLY is set (%r). That narrows a gate's scope to named "
            "screens, which is exactly what this gate forbids. It is for "
            "the mutation suite only." % os.environ["WF_ONLY"])

    for name in gates:
        if name in NOT_GATES:
            continue
        src = open(os.path.join(HERE, name), encoding="utf-8").read()
        if "population." in src:
            how = "derived (population)"
        elif "glob(" in src and "*.html" in src:
            # Correct, and reported distinctly rather than as "no SCREENS":
            # a gate that globs the directory itself has the right property
            # already. Naming it that way stops a reader assuming the row is
            # a gap and stops the row hiding one.
            how = "derived (own glob)"
        elif _binds_screens(os.path.join(HERE, name)):
            how = "SCREENS present, NOT derived"
            fails.append("%s has a SCREENS binding that is neither derived "
                         "from population.py nor a directory glob." % name)
        elif "import tokens" in src:
            # A gate whose subject is not a screen at all. verify_designmd
            # measures the stylesheets and the normative document, and its
            # population (every :root block in every *.css) is derived by
            # tokens.py the same way population.py derives screens.
            #
            # KEYED ON THE IMPORT, NOT ON THE FILE NAME. Naming the gate here
            # would be this file's own rule broken inside this file: the next
            # document-level gate would print the ambiguous row again and
            # somebody would come back to add a second name.
            #
            # REPORTED DISTINCTLY ON PURPOSE. Round 5's finding was that "no
            # screen loop" reads as "nothing to derive" while meaning "a
            # population of one that nothing can see". Letting a genuinely
            # screen-free gate print that same string puts a second meaning on
            # a phrase that was already ambiguous, and the next reader has to
            # open the file to tell which is which.
            how = "derived (tokens, not screens)"
        else:
            how = "no screen loop"
        rows.append((name, how))

    print("=" * 78)
    print("verify_coverage.py  every gate's scope is derived, never named")
    print("=" * 78)
    print()
    print("%-30s %s" % ("gate", "screen population"))
    print("-" * 56)
    for name, how in rows:
        print("%-30s %s" % (name, how))

    print()
    print("html files on disk:      %d" % len(on_disk))
    print("payment screens:         %d  (loads flow.css, or named with a reason)"
          % len(pay))
    print("general screens:         %d  (the COMPLEMENT, so a new screen is"
          % len(gen))
    print("%-24s     swept by default rather than forgotten)" % "")
    if excused:
        print()
        print("named by hand, each with its reason recorded in this file:")
        for name, var, n in excused:
            print("  %s %s (%d)" % (name, var, n))

    if fails:
        print()
        # The header used to say "N gate(s) name their own screens" for every
        # entry in this list, including the partition failures, which made a
        # correctly-caught partition break read as a naming violation. A
        # failure message that misnames the failure sends the next reader to
        # the wrong file.
        print("FAIL: %d scope problem(s)." % len(fails))
        for f in fails:
            print("  " + f)
        print()
        print("A list of names cannot fail on a screen it does not mention.")
        print("That is how twenty-five screens went unmeasured against a rule")
        print("three documents asserted of all of them.")
        return 1

    print()
    print("PASS: no gate names a screen, in a list or inline, and the")
    print("      population derivations cover the directory exactly once.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
