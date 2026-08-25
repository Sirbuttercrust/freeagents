# Handoff: R-31 (#50) - complete

## What was done

Lap A (withdrawn outcome):

- `src/domain/job.ts`: `withdrawn` added to `JobStatus` and to
  `TERMINAL_STATUSES`; the transition table now names `withdrawn` from draft,
  proposed, confirmed, submitted and stale, and `withdrawn` maps to no
  outgoing edges. New `recordWithdrawn` records the outcome. Header comment
  names the status.
- `prisma/schema.prisma`: `withdrawn` added to the `JobStatus` enum with an
  R-31 comment. The driver passes status strings through opaquely
  (src/adapters/storage/prisma.ts raw row type), so no driver edit and no
  generated-client regeneration.
- `src/api/app.ts`: body-less `POST /jobs/:jobId/withdraw` wired through the
  shared `runExchange` skeleton with `recordWithdrawn`; the route only names
  the label.
- Tests: `tests/domain/job.test.ts` gains the withdrawn reachability and
  terminality pins plus a `recordWithdrawn` suite and the terminality rename;
  new `tests/api/job-withdraw.test.ts` pins the 200 projection from submitted
  and stale (same submitted keyset, only status moved, no mergeCommit/mergedAt
  keys, string deadline, read-back), the 409 from every terminal status
  including a second withdraw, the 404, and the 503 with cause logged;
  `tests/api/job-invariant2.test.ts` gains a withdrawn leg in the outcome
  absence suite.

Lap B (outcome update after stale):

- `src/domain/job.ts`: `stale -> closed_unmerged` added to the transition
  table; the R-12 comment updated to say R-31 closed the deferred question.
- `tests/domain/job.test.ts`: the pin that asserted the edge was refused now
  pins it as legal, and the `recordClosedUnmerged` suite records the outcome
  from stale.
- `tests/api/job-merge.test.ts`: the stale-closed leg of the merge suite is
  now the 200 closed_unmerged outcome with the full projection and read-back,
  replacing the 409 expectation.
- `src/api/app.ts`: comment-only update to the outcome closure's 409 note.

## Where this stands

Both laps of the plan are done. The scoped gate
(`sandboxed.sh python3 harness/ci.py --quick`) is green after every task:
typecheck, lint, and the full unit run. The suite grew from 369 tests to 378,
all passing. The e2e smoke reports `E2E_STEPS_ASSERTED=74`, unchanged from
before this work. This implement seat cannot run the no-arg full CI (the
scope guard allows only the `--quick` gate) and cannot run git, so no commit
exists; the changes sit in this worktree for the review seat.

## What remains

Nothing in the plan. For the review seat: run the full
`python3 harness/ci.py` outside this seat's scope and commit.

## What could trip up the next builder

- The `JobTransitionError` message reads `cannot transition from "<status>" a
  job in status "<status>"` for terminal sources; pin it whole, not by prefix.
- The 409 path of the merge route's outcome closure stays live: a withdrawn
  row reaching the route is terminal, so its observation throws through
  `recordClosedUnmerged`/`completeJob` instead of the early non-observation
  guard, because `withdrawn` was not added to that guard's status list. The
  plan did not ask for the guard to change, and the 409 outcome is the same.
- The `PlantedJobRepository` in tests/api/job-withdraw.test.ts resolves
  updates as given; the 503 leg relies on the row NOT moving when the write
  rejects, which the class implements deliberately.
- Do not run the sandboxed gate through a pipe or redirect; the sandbox
  refuses chained commands.

## Gate evidence

Last run: `GATE_OK mode=quick`, `UNIT_PASSED tests=378`,
`E2E_STEPS_ASSERTED=74`.
