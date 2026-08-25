# Handoff: R-36 / #65 (merge route issues and stores the credential) - Lap A done

## What was done (Lap A)

Wired credential issuance into the merge route, keeping every existing test
green.

- `src/adapters/github/types.ts`: `PullRequestSummary` gains `additions`,
  `deletions`, `filesChanged` (ENT-8 diffSize), sourced straight off GitHub's
  own PR object. Five test literals across `tests/api/job-merge.test.ts`,
  `tests/api/job-invariant2.test.ts` and `tests/e2e/smoke.test.ts` updated to
  construct the widened type.
- `src/api/app.ts`:
  - `createApp` gains a seventh, defaulted parameter,
    `credentialRepo: CredentialRepository = createCredentialRepository()`.
    `credentials` keeps its existing `createCredentialResolver()` default.
  - `POST /jobs/:jobId/merge`'s merged leg: after `completeJob` succeeds
    (unchanged, still step one with its 409 mapping), the route resolves the
    agent DID (503 `identity resolution unavailable` on failure or on a DID
    document with no verification method), builds a `WorkHistoryClaim` from
    the job row and github's report, and issues the credential (503
    `credential issuance unavailable` on failure) - all BEFORE persistence,
    so a signing failure leaves the job `submitted` and retryable. Only then
    does `jobRepo.complete(...)` run (unchanged 404/503 mappings), followed
    by `credentialRepo.save(...)` (409 on `CredentialAlreadyIssuedError`, 503
    otherwise). The 200 response is `{ ...jobProjection(row), credential }`.
  - The URL-narrowing step deviates from the plan's exact wording: the plan
    assumed TypeScript would narrow `pullRequestUrl` to `string` purely from
    the `match === null` throw on a ternary-derived `match`. It does not -
    `tsc` reported `string | null` still reaching the claim's
    `pullRequestUrl` field. Fixed with an explicit
    `if (pullRequestUrl === null) throw ...` guard before building `match`,
    which narrows correctly and keeps the same error message and 500
    mapping. No other behavior changed from what the plan specified.
  - `GET /jobs/:jobId`: for a job whose `mergeCommit` is not null, attaches
    the stored credential (`credentialRepo.findByDocumentId(row.id)`) when
    present; absent (not `null`) when no credential row exists.
    `jobProjection` itself untouched.
- Tests:
  - `tests/api/job-merge.test.ts`: `startWith` gains a third optional
    `{ identity?, credentials?, credentialRepo? }` argument, defaults to a
    fake identity (`resolveDid` returns `${did}#key-1`) and a real
    `createCredentialsAdapter` with a fixed test issuer
    (`did:abt:platform-merge-test`, seed `new Uint8Array(32).fill(7)`) over a
    fresh `MemoryCredentialRepository`, and now returns `credentialRepo`
    alongside `server`/`baseUrl`. `COMPLETED_KEYS` gains `'credential'`. The
    happy-path test asserts the issued credential's subject fields
    (jobId/mergeCommitSha/mergedAt/diffAdditions/diffDeletions/filesChanged/
    id/signedBy/repository/buyerDid), `proof.type`, and that the stored copy
    (`credentialRepo.findByDocumentId`) round-trips to the same bytes the
    caller received. No other existing test in the file needed assertion
    changes - `COMPLETED_KEYS` updating in one place was enough for the
    other merged-outcome legs (`still completes a stale job...`) to keep
    passing, since they all reuse that constant.
  - `tests/e2e/smoke.test.ts`: swapped the app's credentials adapter from
    `createCredentialResolver(credentialRepo)` to
    `createCredentialsAdapter({ did: E2E_ISSUER_DID, seed: ... }, credentialRepo)`
    (module-level issuer DID + `nodeCrypto.randomBytes(32)` seed), and passes
    `credentialRepo` as `createApp`'s new seventh argument. The merged-key
    list gains `'credential'` (sorted between `createdAt` and `criteria`).
    Header comment (step 7) now names R-36. `createCredentialResolver`
    import replaced (no longer used in this file).

## Where this stands

The scoped gate (`sandboxed.sh python3 harness/ci.py --quick`) is green:
`TYPECHECK_OK`, `LINT_OK`, `UNIT_PASSED tests=415`, `E2E_PASSED`,
`E2E_STEPS_ASSERTED=76` - identical to the pre-work baseline (Lap A adds
assertions to existing tests rather than new test files, so the count did
not move; Lap B adds the new test files/cases).

## Lap B is required before this branch can pass MISSION Gate 2

Per `plan.md`, Lap B is NOT optional - without it, invariant 2 (a third
party verifies the merge-issued credential with an off-the-shelf verifier,
no code of ours in the path) has no test proving it holds for the credential
that actually comes out of the HTTP merge route. Lap B tasks, verbatim from
`plan.md`:

**Task B1** - the four failure legs and the absence leg. In
`tests/api/job-merge.test.ts`'s `job merge, faulted legs (R-11)` describe
block, using `startWith`'s new overrides: (1) identity resolution fails →
503, job stays `submitted`, `jobRepo.complete` never called; (2) issuance
fails → 503, same retryable-submitted assertion; (3) credential storage
fails → 503, but the job IS completed (`status: 'completed'` with no
`credential` key on read-back) - the residual the route's comment names; (4)
already issued → 409 with the job named in the error, via a planted row and
a pre-loaded `MemoryCredentialRepository`; (5) absence on read - for a
completed job whose credential row was never written, `'credential' in
body === false` on `GET /jobs/:jobId`, never `null`.

**Task B2** - the invariant-2 test (MISSION Gate 2; this is not optional).
New file `tests/api/job-merge-credential-invariant2.test.ts`, mirroring
`src/api/app.ts`'s merge route. Copy `verifyIndependent`,
`didFromKey`/`generateKey` verbatim from
`tests/adapters/credentials/work-history-invariant2.test.ts` (R-14). Walk a
job draft → merged over HTTP only, assert
`verifyIndependent(credential)` (parsed off the wire, JSON round-tripped)
is `true`, `proof.type === 'Ed25519Signature2020'`,
`typeof proof.proofValue === 'string'`, `proof.jws` undefined. Tamper legs on
`mergeCommitSha` and `id` each make `verifyIndependent` return `false`. The
same document served by `GET /v1/credentials/<jobId>` verifies too. No key
material (privatekey/secretkey/secret/keypair/mnemonic) anywhere in the
merge response, lowercased.

**Task B3** - Gate 3 step 7 in the e2e smoke test. In
`tests/e2e/smoke.test.ts`'s existing merge flow (after the read-back
assertion), assert `mergeBody.credential` is truthy with the right
`jobId`/`mergeCommitSha`, fetch `GET /v1/credentials/${jobId}` (200,
`application/ld+json`, deep-equals `mergeBody.credential`), and verify it
with the off-the-shelf stack (`Ed25519VerificationKey2020.fromFingerprint`,
`securityLoader()`, `vc.verifyCredential`) already imported in the file.
Update the file header to name R-36 as MISSION Gate 3 step 7. Then rewrite
this `HANDOFF.md` to say both laps are done, with the final
`UNIT_PASSED tests=N` and `E2E_STEPS_ASSERTED=N`.

## What could trip up the next builder

- The `pullRequestUrl` narrowing note above: do not revert to the ternary
  form from the plan prose, it does not typecheck under this repo's
  `tsconfig` (no `strictNullChecks`-defeating tricks needed - a plain `if`
  guard is enough and is what's in the tree now).
- `startWith`'s new third argument is `{ identity?, credentials?,
  credentialRepo? }`, all optional, with `exactOptionalPropertyTypes`
  respected via `??` before use, not spreading a possibly-undefined
  property. B1's overrides should follow the same pattern.
- The merge route's identity-resolution 503 leg and the credential-issuance
  503 leg both need `jobRepo.complete` spied and asserted as never called -
  that is the ordering property the whole change exists to prove, and it is
  easy to write a passing test that doesn't actually check it (e.g. only
  checking the status code).
- `ISSUER_DID`/`ISSUER_SEED` in `tests/api/job-merge.test.ts` are the
  defaults `startWith` uses when no override is given; B2's invariant-2 test
  should NOT reuse `createCredentialsAdapter` from
  `src/adapters/credentials/credentials.ts` inside its verification helper -
  only inside the app setup. `verifyIndependent` must not import anything
  from that module (per plan.md task B2).

## Gate evidence

Last run: `GATE_OK mode=quick`, `TYPECHECK_OK`, `LINT_OK`,
`UNIT_PASSED tests=415`, `E2E_PASSED`, `E2E_STEPS_ASSERTED=76`.
