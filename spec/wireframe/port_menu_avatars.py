"""Replace the flat account-menu disc with the generated identity avatar.

WHY A SCRIPT AND NOT EIGHT HAND EDITS

The eight are byte-identical, which is what made them one defect rather than
eight. Editing them by hand is how seven get fixed and one keeps the disc,
and a survivor is worse than the original because the gate then reads as
having passed something it never saw.

WHICH DID, AND WHY IT IS NOT A CHOICE I MADE

The avatar beside the account menu is the SIGNED-IN account, so the DID has
to be the one this tree says belongs to the reader. It states that in exactly
one place: settings.html, under `Your identity (DID)`. Every one of these
eight menus links to that same settings page. So the DID is read OUT of
settings.html at run time rather than typed here, and if the tree ever states
a different one, this script and the pages disagree loudly instead of quietly.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

DISC = re.compile(
    r'<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" '
    r'r="16" fill="#3A3A4A"/></svg>')

# The line settings.html renders under "Your identity (DID)".
YOURS = re.compile(r"<dt>Your identity \(DID\)</dt>\s*<dd>(did:abt:[A-Za-z0-9]+)</dd>")


def main():
    src = open(os.path.join(HERE, "settings.html"), encoding="utf-8").read()
    m = YOURS.search(src)
    if not m:
        print("settings.html no longer states 'Your identity (DID)'. That line "
              "is where the\nsigned-in DID comes from; without it this script "
              "would have to invent one.")
        return 2
    did = m.group(1)
    print("signed-in DID, read from settings.html: %s" % did)

    # data-avatar-size is stated rather than measured because the summary is
    # 44x44 and the svg inside it is 30x30: polish.js would otherwise size the
    # avatar to the button and the menu would grow.
    new = ('<span class="av" data-avatar="%s" data-avatar-size="30" '
           'aria-hidden="true"></span>' % did)

    changed = []
    for name in sorted(os.listdir(HERE)):
        if not name.endswith(".html"):
            continue
        path = os.path.join(HERE, name)
        text = open(path, encoding="utf-8").read()
        if not DISC.search(text):
            continue
        text, n = DISC.subn(new, text)

        # A page that renders [data-avatar] must load swarm.js or the span
        # paints an empty box. BUILD-STATE already writes that rule; nothing
        # enforced it, and two of these eight do not load it today.
        if "swarm.js" not in text:
            text = text.replace('<script src="icons.js"></script>',
                                '<script src="swarm.js"></script>\n'
                                '<script src="icons.js"></script>', 1)
            note = "  + swarm.js"
        else:
            note = ""
        open(path, "w", encoding="utf-8").write(text)
        changed.append("%-18s %d disc%s%s" % (name, n, "" if n == 1 else "s", note))

    for line in changed:
        print("  " + line)
    print("%d files" % len(changed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
