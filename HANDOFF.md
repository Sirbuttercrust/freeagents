# Handoff: R-36 / #65 (merge route issues and stores the credential) - both laps done

## What was done

**Lap A** wired credential issuance into the merge route (see prior handoff
content, now superseded by this summary): `PullRequestSummary` gained
`additions`/`deletions`/`filesChanged`; `POST /jobs/:jobId/merge` issues a
work-history credential before persisting the completion (so a signing
failure leaves the job `submitted` and retryable), then persists the job and
the credential; `GET /jobs/:jobId` attaches the stored credential when one
exists.

**Lap B** added the failure legs and the invariant-2 proof:

- `tests/api/job-merge.test.ts` (`job merge, faulted legs (R-11)` describe
  block): five new legs - identity resolution rejects (503, job stays
  `submitted`, `jobRepo.complete` never called), a resolved DID document with
  no verification method (503, same retryable-submitted assertion),
  credential issuance rejects (503, same retryable-submitted assertion),
  credential storage rejects (503, but the job IS completed - `completed`
  with no `credential` key on read-back, the residual the route's own
  comment names), and an already-issued credential on a completed job (409,
  the job id in the error body). A planted `CompletingRepository` gives the
  409 leg a known job id before the request, per the plan.
- `tests/api/job-merge-credential-invariant2.test.ts` (new file): copies
  `verifyIndependent`/`didFromKey`/`generateKey` verbatim from
  `tests/adapters/credentials/work-history-invariant2.test.ts` (R-14, no
  import from `src/adapters/credentials/credentials.ts` in the verification
  path), starts a real `createApp(...)` with an issuer DID derived from its
  own key (so the binding check inside `verifyIndependent` accepts it), walks
  a job draft -> merged over HTTP only, and proves: the merge-issued
  credential verifies independently; the proof is `Ed25519Signature2020`
  with a `proofValue` and no `jws`; tampering `mergeCommitSha` or the subject
  `id` each fail verification; the same document served by
  `GET /v1/credentials/<jobId>` verifies too; no key-material stems appear in
  the merge response.
- `tests/e2e/smoke.test.ts`: after the existing merge read-back assertion
  (step 8), added step 7b - asserts `mergeBody.credential`'s subject fields,
  fetches `GET /v1/credentials/${jobId}` (200, `application/ld+json`,
  deep-equal to `mergeBody.credential`), and verifies the resolved document
  with the off-the-shelf stack already imported in the file
  (`Ed25519VerificationKey2020.fromFingerprint`, `securityLoader()`,
  `vc.verifyCredential`). Header comment (step 7) now names R-36 as MISSION
  Gate 3 step 7 explicitly.

## Deviations from plan.md

None beyond the one already recorded from Lap A (the `pullRequestUrl`
narrowing needed an explicit `if` guard, not the plan's ternary form, to
satisfy `tsc`). Lap B otherwise matches tasks B1/B2/B3 as written, plus one
addition not explicitly enumerated by the plan: a sixth failure leg (the
resolved DID document carrying an empty `verificationMethod` array), added
because `src/api/app.ts`'s merge route has its own `signedBy === undefined`
branch (mirrored from the account-proof route but a distinct code path in
this function) that the plan's five listed legs did not otherwise exercise.

## Gate evidence

Last run: `GATE_OK mode=quick`, `TYPECHECK_OK`, `LINT_OK`,
`UNIT_PASSED tests=426`, `E2E_PASSED`, `E2E_STEPS_ASSERTED=77` (up from the
Lap A baseline of 415 / 76, both rose as required and the floor in
`.factory/locks/floor.json` was never touched).

## Files changed (both laps, PR total)

`src/adapters/github/types.ts`, `src/api/app.ts`,
`tests/api/job-merge.test.ts`, `tests/api/job-invariant2.test.ts`,
`tests/e2e/smoke.test.ts`, `tests/api/job-merge-credential-invariant2.test.ts`
(new) - six files, matching the plan's fixed file list exactly.
