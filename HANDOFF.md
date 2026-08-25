# Handoff: R-17 (#24), Lap A complete, Lap B drafted then reverted for size

## Where this stands

Lap A of the plan is done and committed-ready:

- `src/domain/profile.ts` (new): `evidenceRecord`, the pure fold from a list
  of `EvidenceItem<T>` to three labelled, counted buckets. No total, no sum,
  no score.
- `tests/domain/profile.test.ts` (new): the seven cases from the plan, using
  2/3/4 counts chosen so no legitimate count collides with any pairwise or
  three-way sum.
- `src/adapters/storage/types.ts`: `StoredCredential` and
  `CredentialRepository.listBySubjectDid`.
- `src/adapters/storage/memory.ts`: the credential rows map now holds
  `{ completedJobId, subjectDid, document }` instead of a bare document, so
  `listBySubjectDid` can filter by subject. `listBySubjectDid` returns newest
  first via `.reverse()` on insertion order.
- `src/adapters/storage/prisma.ts`: `listBySubjectDid` via
  `db().credential.findMany({ where: { subjectDid }, orderBy: { issuedAt:
  'desc' } })`.
- `tests/adapters/storage-memory.test.ts`, `tests/adapters/prisma.test.ts`:
  driver tests for the new query, including the `findByDocumentId` regression
  case the row-type change could have broken.
- `tests/api/credential-resolve.test.ts`: one-line fixture fix. Its
  `FailingCredentialRepository`-style inline object implements
  `CredentialRepository` and needed the new `listBySubjectDid` method added
  to keep typechecking; this is a mechanical consequence of widening the
  interface in this lap, not scope creep.

Gate evidence, last run: `GATE_OK mode=quick`, `UNIT_PASSED tests=430`.
`tests/architecture/domain-purity.test.ts` passes, confirming
`src/domain/profile.ts` imports nothing outside `src/domain` besides
`./evidence.js`.

## Why Lap B was drafted, then reverted

I implemented the whole plan (Lap A + Lap B) in one pass before checking the
cumulative diff size against the 500-changed-line cap. Lap A alone is ~409
changed lines (200 insertions/5 deletions across the six edited files, plus
204 lines of new domain code and its test). Adding Lap B's route
(`src/api/app.ts`, +57 lines) and its two new test files
(`tests/api/profile.test.ts` ~298 lines, `tests/api/profile-invariant2.test.ts`
~308 lines) pushed the total to roughly 1070 changed lines, well over the
cap. Since the cap says to stop and report rather than ship something nobody
could review even in principle, I reverted every Lap B edit
(`src/api/app.ts` is back to its pre-Lap-B state, both new test files
deleted) and stopped at the Lap A checkpoint the plan itself names in Task
A5.

The Lap B work was implemented and gate-green before the revert, so it is
not speculative: a future session can redo it from the plan text directly
(Task B1/B2/B3), or from this note's summary of what I built the first time:

- `src/api/app.ts`: seventh `createApp` parameter
  `credentialRepo: CredentialRepository = createCredentialRepository()`
  (importing `createCredentialRepository` from `../adapters/storage/storage.js`
  and `type CredentialRepository`, `type StoredCredential` from
  `../adapters/storage/types.js`); a `hireItem(row: StoredCredential)` helper
  beside `agentProjection` returning `credentialPath`, `jobId`, `repository`,
  `pullRequestUrl`, `mergeCommitSha`, `mergedAt`; and
  `GET /agents/:agentDid/profile` registered above the two `notImplemented`
  stubs, doing `agentRepo.findByDid` (404 on null),
  `credentialRepo.listBySubjectDid(row.did)`, mapping each row to an
  `EvidenceItem` with facts `{ platformBrokered: true, pullRequestMerged:
  true, signedCommit: false, repositoryPublic: true, ownerSubmitted: false }`
  (repositoryPublic assumed true per ASSUMPTIONS A-R17-3), then
  `evidenceRecord(items)`, and `res.json({ agent: agentProjection(row),
  evidence: <record> })`; catch maps to 503 `{ error: 'storage unavailable' }`.
- `tests/api/profile.test.ts`: the six cases from the plan (one hire renders,
  the credentialPath resolves, zeros render as zeros, 404, 503 on the
  credential store and on the agent lookup, two agents don't see each
  other's hires).
- `tests/api/profile-invariant2.test.ts`: the five cases from the plan. Two
  notes for whoever redoes this:
  - The "no blended score in the source" scan must strip `//` and `/* */`
    comments before matching `/(score|total|rating|...)/i`, or it trips on
    `profile.ts`'s own header comment ("no total, no sum, no score") and on
    this test file's own docstring. `profile-invariant2.test.ts` had a
    `stripComments` helper for this; keep it.
  - The "profile embeds no credential document: no proof, no @context" check
    must be scoped to `body.evidence`, not the whole response body:
    `body.agent` legitimately carries the agent's own delegation VC
    (`agentProjection`'s pinned nine-key contract), which has its own
    `proof` and `@context`. Scanning the whole body fails on that legitimate
    field.
  - The "no numeric value equals the sum of the three tier counts" check
    from the plan is not fully realizable at the API layer today: only
    `verifiedHire` has a source via HTTP (prior-work and portfolio have no
    domain type per this issue's non-goals), so with one non-zero tier the
    sum always equals that tier's own count. I asserted the exact numeric
    footprint (`{0, 1}` for a one-hire fixture) instead of an exclusion list,
    and documented why in a comment. A future session doing Lap B should
    keep that reasoning or improve on it, not silently drop the check.

## What remains

Lap B, exactly as the plan states it: `src/api/app.ts` (the route),
`tests/api/profile.test.ts`, `tests/api/profile-invariant2.test.ts`. Three
files, no more, per the plan's file budget.

## Gate evidence

Last run (Lap A only, current working tree): `GATE_OK mode=quick`,
`UNIT_PASSED tests=430`.
