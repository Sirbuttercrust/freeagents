#!/usr/bin/env python3
"""The gate. One command that decides whether this repository is working.

WHY THIS FILE EXISTS
`FACTORY_RULES.md` §3 names `python harness/ci.py` as gates 1 and 2, and
`CLAUDE.md` maps `harness/` to "the gate. Protected". The factory's merge fence
refuses any pull request whose run log is missing a marker from
`FACTORY_REQUIRED_MARKERS`, which is `APP_STARTED E2E_PASSED PROTECTED_OK
GATE_OK`.

This file had never been written. The factory was configured to run a raw npm
chain instead:

    FACTORY_VALIDATE_CMD="npm run typecheck && npm run lint && npm test"

That chain produces `APP_STARTED` and `E2E_PASSED`, because the e2e smoke test
prints them, and `PROTECTED_OK`, because `factory/guard.py` runs separately and
its output is captured into the same log. It produces **no GATE_OK, ever**, from
any outcome. So the merge fence blocked every pull request unconditionally, and
was right to: a marker that no code prints is a check that never ran.

Measured 2026-08-19 before writing this file:

    typecheck=0 lint=0 test=0
    APP_STARTED    1
    E2E_PASSED     1
    PROTECTED_OK   0     (produced by guard.py, not by this chain)
    GATE_OK        0     <- nothing anywhere could print this

That is the whole reason the factory has never merged a pull request on its own.

THE RULE THIS FILE OBEYS
A marker means "this specific check RAN and passed". Never print one at the top,
never in a `finally`, never on a path where the thing it names did not happen. A
green log for a red run is the exact failure the marker mechanism exists to
catch, so the ordering here is load-bearing rather than stylistic.

USAGE
    python3 harness/ci.py            the full gate
    python3 harness/ci.py --quick    the cheap subset a builder may self-run

`--quick` is a STRICT subset: it must never contain a check the full run lacks.
Nothing downstream trusts it, because the full gate re-runs everything
independently.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUICK = "--quick" in sys.argv


def run(step: str, cmd: str, timeout: int = 900) -> tuple[int, str]:
    """Run one rung. Returns (exit code, combined output).

    Output is streamed to our own stdout as well as captured, so a human
    watching a run sees progress and the gate log keeps everything.
    """
    print(f"--- {step}: {cmd}", flush=True)
    started = time.time()
    try:
        p = subprocess.run(
            cmd, shell=True, cwd=ROOT, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        out = p.stdout or ""
        rc = p.returncode
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or "") if isinstance(e.stdout, str) else ""
        out += f"\nTIMEOUT after {timeout}s"
        rc = 124
    print(out, end="" if out.endswith("\n") else "\n", flush=True)
    print(f"--- {step}: rc={rc} in {time.time() - started:.1f}s", flush=True)
    return rc, out


def fail(step: str, detail: str = "") -> int:
    """Name the rung that stopped the run.

    An unattended system that misnames its own failure sends whoever reads the
    log at 3am to the wrong file, and that is most of the cost of a failure
    nobody watched.
    """
    print(f"GATE_FAILED: {step}", flush=True)
    if detail:
        print(detail.strip()[-2000:], flush=True)
    return 1


def main() -> int:
    print(f"HARNESS_START mode={'quick' if QUICK else 'full'} repo=freeagents", flush=True)

    # --- 1. static ----------------------------------------------------------
    rc, out = run("typecheck", "npm run typecheck")
    if rc != 0:
        return fail("typecheck", out)
    print("TYPECHECK_OK", flush=True)

    rc, out = run("lint", "npm run lint")
    if rc != 0:
        return fail("lint", out)
    print("LINT_OK", flush=True)

    print("STATIC_OK", flush=True)

    # --- 2. unit ------------------------------------------------------------
    # The full vitest run also executes tests/e2e/smoke.test.ts, which is what
    # prints APP_STARTED and E2E_PASSED. Those markers therefore come from a
    # real booted server, not from this file.
    rc, out = run("unit", "npm test")
    if rc != 0:
        return fail("unit", out)

    # ZERO IS NOT A PASS. A suite that discovered nothing exits 0 and looks
    # perfect. vitest prints "Tests  39 passed (39)".
    m = re.search(r"Tests\s+(\d+)\s+passed", out)
    ran = int(m.group(1)) if m else 0
    if ran == 0:
        return fail(
            "unit",
            "UNIT_ERROR: the runner reported 0 tests. A suite that ran nothing "
            "is not a suite that passed. If the count is real, fix the regex in "
            "harness/ci.py.",
        )
    print(f"UNIT_PASSED tests={ran}", flush=True)

    # The e2e markers must have come from that run. Asserting their presence
    # here turns a silently-removed smoke test into a gate failure instead of a
    # quietly weaker gate.
    if "APP_STARTED" not in out:
        return fail("e2e", "APP_STARTED absent: nothing proved the app can boot.")
    if "E2E_PASSED" not in out:
        return fail("e2e", "E2E_PASSED absent: the end-to-end path did not report.")

    steps = 0
    # The smoke test prints `E2E_STEPS_ASSERTED=<n>` on its own line, then
    # `E2E_PASSED`. Parse the real format rather than a guessed one: a floor
    # check that silently reads 0 because its regex missed would let a pull
    # request delete every assertion and still pass.
    ms = re.search(r"E2E_STEPS_ASSERTED=(\d+)", out)
    if ms:
        steps = int(ms.group(1))
    else:
        return fail(
            "e2e",
            "E2E_PASSED was printed but E2E_STEPS_ASSERTED was not. The step "
            "count is what the floor ratchets against, so a missing count is a "
            "gate that cannot tell a full end-to-end run from an empty one.",
        )

    if QUICK:
        # The subset an implementing node runs on itself while it works.
        print("GATE_OK mode=quick", flush=True)
        return 0

    # --- 3. the e2e step floor ----------------------------------------------
    # A human-chosen minimum, read from a protected lock file, so that raising
    # it is a deliberate commit and LOWERING it cannot happen in the same pull
    # request that made the floor inconvenient.
    floor_path = ROOT / ".factory" / "locks" / "floor.json"
    if floor_path.exists():
        try:
            floor = json.loads(floor_path.read_text()).get("e2e_steps_asserted", 0)
        except (ValueError, OSError) as e:
            return fail("floor", f"could not read {floor_path}: {e}")
        if steps < floor:
            return fail(
                "floor",
                f"E2E_PASSED steps={steps} is below the floor of {floor} in "
                f".factory/locks/floor.json. Either the end-to-end path lost "
                f"assertions or the floor is wrong; only a human commit may "
                f"lower it.",
            )
        print(f"FLOOR_OK steps={steps} >= {floor}", flush=True)
    else:
        print(
            "FLOOR_ABSENT no .factory/locks/floor.json - the e2e step count is "
            "not ratcheted, so a pull request could silently delete assertions "
            "and still pass.",
            flush=True,
        )

    # --- 4. holdout ----------------------------------------------------------
    # Assertions the BUILDER cannot read. Everything the builder can read sits
    # inside its own optimisation loop; given enough attempts it satisfies those
    # rather than the thing you meant.
    holdout = ROOT / ".factory" / "holdout" / "run.py"
    if holdout.exists():
        rc, out = run("holdout", f'{sys.executable} "{holdout}"')
        if rc != 0:
            return fail("holdout", out)
        print("HOLDOUT_OK", flush=True)
    else:
        print(
            "HOLDOUT_ABSENT no .factory/holdout/run.py - NOTHING above the "
            "independence line ran. Every check in this gate is one the builder "
            "could read and iterate against.",
            flush=True,
        )

    # --- 5. mutations --------------------------------------------------------
    # A gate that has never failed is a gate nobody has tested.
    mutate = ROOT / "harness" / "mutations" / "run.py"
    if mutate.exists():
        rc, out = run("mutations", f'{sys.executable} "{mutate}"', timeout=1800)
        if rc != 0:
            return fail("mutations", out)
    else:
        print(
            "MUTATIONS_ABSENT no harness/mutations/run.py - this gate has never "
            "been shown to fail.",
            flush=True,
        )

    print("GATE_OK mode=full", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
