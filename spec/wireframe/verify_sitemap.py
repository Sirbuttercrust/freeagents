#!/usr/bin/env python3
"""Does SITEMAP.md tell the truth about what is built?

WHY. SITEMAP.md is one of the two audit contracts for this directory, and it
carries a build claim per page ("Built as `hire.html`" or "**Not built.**").
Those claims are prose, so nothing keeps them honest as screens land. A doc
that says a page does not exist while the page is being served is worse than
no doc: the next person builds it twice, or trusts a different stale line.

Three checks, all mechanical:

  1  every page SITEMAP claims is built as <file> has that file on disk
  2  no page marked "Not built" actually exists and is reachable
  3  every served flow screen has a page id, so nothing ships unlisted

Check 3 is the one that found something: outcomes.html was linked from the
landing page and had no entry at all.

    python3 verify_sitemap.py
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITEMAP = os.path.join(HERE, "SITEMAP.md")

text = open(SITEMAP, encoding="utf-8").read()

# Split into "### P-n Title" sections so a claim can be attributed to a page.
parts = re.split(r"^### (P-\d+) (.+)$", text, flags=re.M)
sections = []
for i in range(1, len(parts), 3):
    sections.append((parts[i], parts[i + 1].strip(), parts[i + 2]))

# Files that are deliberately kept as a record of a superseded design. They
# carry a visible banner and are excluded from reachability by verify_links.py.
SUPERSEDED = {"confirm.html", "criteria.html"}

# Not pages: shared assets and the gates themselves.
NOT_PAGES = {"base.css", "flow.css"}

# The page id -> file mapping for pages whose section says "Built." with no
# filename, or whose filename is not derivable from the title. Read off the
# nav and the link graph rather than guessed, because a wrong guess here
# produces a confident false report in both directions.
KNOWN = {
    "P-1": "index.html",
    "P-2": "browse.html",
    "P-3": "agent.html",
    "P-4": "operator.html",
    "P-5": "credential.html",
    "P-6": "verify.html",
    "P-7": "how.html",
    "P-8": "signin.html",
    "P-9": "dashboard.html",
    "P-16": "myjobs.html",
    "P-29": "notfound.html",
    "P-30": "error.html",
}

fails = []
rows = []

claimed_files = set()
for pid, title, body in sections:
    # The filename charset must allow every character a real filename can
    # carry. An earlier `[a-z0-9]+` could not match a hyphen, so a claim of
    # `conduct-missing.html` did not parse as a claim AT ALL: the page fell
    # through to "no build claim", the file showed up in the unlisted sweep,
    # and the gate reported the right failure for the wrong reason. A gate
    # that misattributes a cause sends the next person to the wrong file.
    built = re.search(r"Built as `([A-Za-z0-9_.-]+\.html)`", body)
    plain_built = re.search(r"^Built\.", body, flags=re.M)
    notbuilt = "**Not built.**" in body

    if built:
        fname = built.group(1)
        claimed_files.add(fname)
        exists = os.path.exists(os.path.join(HERE, fname))
        rows.append((pid, title, fname, "claims built", "on disk" if exists else "MISSING"))
        if not exists:
            fails.append("%s %s: claims `%s`, which is not in this directory"
                         % (pid, title, fname))
    elif plain_built:
        fname = KNOWN.get(pid, "")
        if fname:
            claimed_files.add(fname)
        exists = fname and os.path.exists(os.path.join(HERE, fname))
        rows.append((pid, title, fname, "claims built",
                     "on disk" if exists else "MISSING"))
        if fname and not exists:
            fails.append("%s %s: claims built, but `%s` is not in this directory"
                         % (pid, title, fname))
    elif notbuilt:
        # A page marked not built must not be sitting there served.
        fname = KNOWN.get(pid, "")
        exists = fname and os.path.exists(os.path.join(HERE, fname))
        if exists:
            claimed_files.add(fname)
        rows.append((pid, title, fname if exists else "", "claims NOT built",
                     "BUT EXISTS" if exists else "absent, consistent"))
        if exists:
            fails.append("%s %s: marked \"Not built\" but `%s` exists and is served"
                         % (pid, title, fname))
    else:
        fname = KNOWN.get(pid, "")
        if fname and os.path.exists(os.path.join(HERE, fname)):
            claimed_files.add(fname)
        rows.append((pid, title, fname, "no build claim", ""))

# Every html file in the directory should be claimed by some page id.
on_disk = sorted(f for f in os.listdir(HERE)
                 if f.endswith(".html") and f not in NOT_PAGES)
unlisted = [f for f in on_disk
            if f not in claimed_files and f not in SUPERSEDED]

print("=" * 74)
print("SITEMAP TRUTH CHECK")
print("=" * 74)
print("\n%-6s %-26s %-18s %-16s %s" % ("id", "title", "file", "claim", "reality"))
for pid, title, fname, claim, reality in rows:
    print("%-6s %-26s %-18s %-16s %s"
          % (pid, title[:26], fname, claim, reality))

print("\nhtml files on disk: %d, claimed by a page id: %d, superseded: %d"
      % (len(on_disk), len(claimed_files), len(SUPERSEDED)))

if unlisted:
    print("\nSERVED BUT UNLISTED:")
    for f in unlisted:
        print("  " + f)
        fails.append("%s is served but no page id claims it" % f)

print()
if fails:
    print("FAIL, %d" % len(fails))
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("PASS  every build claim matches the directory, and every served page")
print("      has a page id.")
