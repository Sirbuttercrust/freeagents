"""The safety rail every mutation suite needs, in one place.

A mutation suite edits real files and restores them from a snapshot taken at
import. That design has one sharp edge, and this session hit it twice:

  A RUN KILLED MID-MUTATION POISONS THE NEXT RUN, SILENTLY.

The killed run leaves the damage on disk. The next run snapshots the DAMAGED
tree, applies its mutation, "restores" to the damage, and reports a revert
failure for a cause hours old. It reads exactly like the gates breaking, and
the tree is left dirty in a way whoever reads the CSS next discovers by
accident.

`verify_flow_mutation.py` grew a lock file for this on 2026-09-09. The other
two suites did not have one, and `BUILD-STATE.md` described the protection as
though all of them did. A round-3 run killed mid-flight then left a planted
20x20 control sitting in `browse.html` with nothing announcing it. Three
copies of a safety rail with only one of them written is the same defect as
three copies of a probe with only one of them correct.

So it lives here and the suites import it.

    import mutationsafe
    mutationsafe.guard(FILES)          # refuses on a stale lock, warns on dirt
    mutationsafe.acquire(FILES)        # before the first mutation
    ...
    mutationsafe.release()             # after the last restore, in a finally

`atexit` cannot do the release under SIGKILL, which is the whole reason the
lock is a file on disk rather than a flag in memory.
"""

import atexit
import os
import signal
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOCK = os.path.join(HERE, ".mutation-in-progress")


def guard(files):
    """Refuse to start on a stale lock; name any dirty file and continue.

    The two are deliberately different. A lock means a run was killed and the
    tree may carry a mutation, which nobody can safely reason about, so it is
    a hard stop. A dirty file is often just somebody mid-edit, so it warns and
    says what will happen: the restore goes back to THIS state, not the
    committed one.
    """
    if os.path.exists(LOCK):
        try:
            held = open(LOCK, encoding="utf-8").read().strip()
        except OSError:
            held = "(unreadable)"
        print("\nREFUSING TO RUN: %s exists." % LOCK)
        print("A previous mutation run was killed before it could restore the")
        print("tree. These files may still carry a mutation:\n")
        print(held)
        print("\nCheck them with  git diff spec/wireframe")
        print("restore anything mutated, then delete the lock file.")
        sys.exit(2)

    try:
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--"] + sorted(files),
            cwd=HERE, capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        dirty = ""
    if dirty:
        print("WARNING: files this suite mutates have uncommitted changes:")
        for line in dirty.splitlines():
            print("   " + line)
        print("   They will be restored to THIS state, not to the committed one.")
        print("   If a previous run was killed, revert them before trusting the")
        print("   result: git checkout -- <file>\n")
    return dirty


def acquire(files, restore=None):
    """Write the lock naming what is about to be edited.

    Written BEFORE the first mutation, so the window where a kill goes
    unrecorded is zero. The file names the paths rather than merely existing,
    because "something somewhere is dirty" is not a diagnosis.

    `restore` is the caller's own revert, and passing it is what makes a
    catchable kill self-healing.

    WHY THE SIGNAL PATH IS WRITTEN THIS WAY, found by being killed.

    The first version of this handler called release() and exited. That is
    worse than having no handler at all: the mutation stays on disk and the
    lock that would have ANNOUNCED it is deleted on the way out, so the next
    run snapshots a damaged tree and nothing says so. It happened during
    round 9: a suite killed mid-run left a planted element in notfound.html
    with no lock beside it, and only a grep found it.

    So the order is restore, then release, and the lock survives anything
    that leaves the tree unproven:

      restore given and it succeeds   tree is clean, drop the lock
      restore given and it raises     tree is unknown, KEEP the lock
      no restore given                tree is unknown, KEEP the lock

    A lock left standing costs the next person one `git checkout`. A lock
    wrongly deleted costs them a debugging session that ends somewhere else.
    """
    with open(LOCK, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sorted(os.path.basename(f) for f in files)) + "\n")

    # A SIGTERM handler as well as atexit: a terminate is catchable and is what
    # a test runner or a supervisor sends. Only SIGKILL gets past both, and
    # that is what the lock file itself is for.
    def _bail(signum, frame):
        if restore is not None:
            try:
                restore()
            except Exception:                                 # noqa: BLE001
                # Could not put the tree back. The lock is now the only
                # record that these files may carry a mutation, so it stays.
                os._exit(130)
            release()
        os._exit(130)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _bail)
        except (ValueError, OSError):
            pass
    # Only on a NORMAL interpreter exit, by which point the suite's own
    # `finally` has restored the tree. The signal path above does not come
    # through here, because os._exit skips atexit deliberately.
    atexit.register(release)


def release():
    try:
        os.unlink(LOCK)
    except OSError:
        pass
