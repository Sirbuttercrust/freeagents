# Roadmap

The ordered backlog. Each item is one pull request's worth of work, cites the
entities it touches, and names what must exist before it can start.

**This is the file a decomposer reads.** Given this plus `entities.md` plus the
current state of the repo, the next unit of work is determined rather than
invented. An issue that cannot cite an `R-` id here does not get filed.

**Ids are stable.** `R-7` means the same thing forever. Never renumber.

**"Done" means:** merged to `main`, the gate green
(`npm run typecheck && npm run lint && npm test`), and the acceptance line
below demonstrably true.

---

## Phase 0: the skeleton

Complete. Domain, adapters, API surface, Prisma schema, 17 tests, and an
architecture test that fails if the domain layer imports I/O.

**Why it is phase 0 and not phase 1:** agents score above 70% extending a
tested codebase and under 5% building structure from nothing. The skeleton is
a human's job precisely because it is the one thing the evidence says not to
delegate. Every new subsystem below gets the same treatment: a human or a
script writes the stub and a failing test, then the factory fills it in.

---

## Phase 1: identity

Nothing else can be built first. An agent with no identity cannot be hired,
credited, or verified.

### R-1 Operator DID: create and store
Depends on: phase 0. Touches ENT-1.
Accept: an operator DID can be registered and read back; the key never touches
our storage.

### R-2 Agent DID: delegate from an operator
Depends on: R-1. Touches ENT-2, ENT-3.
Accept: an agent DID is delegated from an operator DID and the delegation proof
verifies with `@arcblock/vc` without calling our API.

### R-3 GitHub proof, direction one: the DID document
Depends on: R-2. Touches ENT-5.
Accept: a DID document carries `alsoKnownAs` pointing at a GitHub account, and
we can read it.

### R-4 GitHub proof, direction two: the signed gist
Depends on: R-3. Touches ENT-5.
Accept: a public gist on that account carries a statement signed by the DID key;
verification passes only when **both** directions hold; the failure message
names which half failed.

### R-5 Re-check proofs, and downgrade when they stop resolving
Depends on: R-4. Touches ENT-5.3.
Accept: deleting the gist causes the prior-work claim to drop to unverified on
the next check.

### R-6 Key rotation
SPLIT 2026-08-21 into R-29 and R-30. Do not file this one again.

The single build was correct work and the scope guard rejected it at 13 files
against a cap of 12. Same disposition as R-7: the cap does not move, and the
issue is genuinely two pieces of work.

Depends on: R-2. Touches ENT-8.4.
Accept: after rotation, credentials signed by the old key still verify, and the
profile shows the rotation with dates.

---

## Phase 2: the hire loop

The product's spine. Cannot start before phase 1, because a job references two
DIDs that must already exist.

### R-7 Job: draft and brief
SPLIT 2026-08-21 into R-27 and R-28. Do not file this one again.

The single build was correct work and the scope guard rejected it at 14 files
against a cap of 12. The cap is not moving: it exists to stop a node growing a
PR into files nobody asked it to touch, and raising it to fit one issue would
weaken it for every future issue. R-7 is genuinely two pieces of work.

Depends on: R-2. Touches ENT-4.
Accept: superseded by R-27 and R-28 below.

### R-8 Acceptance criteria exchange
Depends on: R-27, R-28. Touches ENT-6.
Accept: the agent proposes criteria, the buyer may request changes, and the
loop can run more than once without creating a job.
Note: Q2 is open. Build the checklist shape, record the assumption.

### R-9 Confirm, and hash the spec
Depends on: R-8. Touches ENT-4.1, ENT-4.2.
Accept: on confirm the job exists with an immutable `specHash`; editing the
criteria afterwards is impossible through any API path.

### R-10 Fork and open the pull request
Depends on: R-9. Touches ENT-4.3, ENT-4.5.
Accept: the agent's PR carries the job id; **no write scope on the buyer's
repository is ever requested**; a test proves the token used has no write
permission on the target.

### R-11 Observe the pull request
Depends on: R-10. Touches ENT-7.1.
Accept: PR opened, updated, merged, and closed states are recorded from
GitHub's API rather than from either party asserting them.

### R-12 Record the outcome, including the unhappy ones
Depends on: R-11. Touches ENT-7.2.
Accept: `closed_unmerged` and `stale` are recorded and visible; neither appears
as a verified hire; neither disappears.
Note: Q3 is open. Build the deadline field, default 30 days, record the
assumption.

---

## Phase 3: credentials

Cannot start before phase 2. A credential attests to a completed hire, so there
must be completed hires.

### R-13 Issue a credential on merge
Depends on: R-11, R-12. Touches ENT-8.
Accept: merging produces a VC recording PR, merge commit, signing key,
timestamp, diff size, and `specHash`, per
`spec/work-history-extension-v1.md`.

### R-14 Verify with an off-the-shelf verifier
Depends on: R-13. Touches ENT-8.1.
Accept: the credential verifies using a third-party W3C verifier, in a test
that does not import our own verification code. **This is the hard invariant
made executable**, and it is the single most important test in the codebase.

### R-15 Resolvable credential endpoint
Depends on: R-13. Touches ENT-8.
Accept: the credential id resolves to the JSON-LD document without
authentication.

### R-16 Compromise window and disputed work
Depends on: R-6, R-13. Touches ENT-8.
Accept: reporting a key compromised marks work signed inside the window as
disputed; nothing is deleted or hidden; the window is visible.

---

## Phase 4: profiles and browse

Depends on phases 1 to 3 for anything real to show, though the shells can be
built earlier against empty data.

### R-17 Agent profile, three tiers, never blended
Depends on: R-2, R-13. Touches ENT-2.4, ENT-8.
Accept: verified hires, verified prior work, and portfolio claims each render
as their own labelled tier; **no code path produces a combined score**; a test
asserts the absence.

### R-18 The cold-start profile
Depends on: R-17.
Accept: an agent with no record renders three zeros with no promotional
framing, no "new" badge, and no reordering to fill the space.

### R-19 Operator profile
Depends on: R-1, R-17.
Accept: lists every agent and the aggregate record.
Note: Q5 is open. Per-agent numbers stay dominant on the agent page.

### R-20 Browse and filter by skill
Depends on: R-17. Touches ENT-2.2.
Accept: top-bar filtering; the evidence row is on the card, not behind a click;
**no popularity or upvote sort exists**.
Note: Q1 is open. Ship "recently listed" and "recently verified" as honest
groupings; do not invent a ranking.

### R-21 DID-derived avatars
Depends on: R-2. Touches ENT-2.3.
Accept: `blobatar` rendered server-side from the DID; same DID gives the same
avatar; no upload path exists anywhere in the codebase.

### R-22 Reviews, restricted to completed hires
Depends on: R-12, R-17. Touches ENT-10.
Accept: only a buyer with a completed hire against that agent can write one;
reviews never aggregate into a displayed score.

---

## Phase 5: platform

### R-23 Sign in without a wallet
Depends on: phase 0. Touches ENT-1.
Accept: browse and verify without an identity; hiring and listing require one;
the limit is stated before a user invests effort.

### R-24 DID Wallet sign-in
Depends on: R-23, R-1.

### R-25 Blocklet packaging
Depends on: most of the above. Deploy as a blocklet.

### R-26 Settlement fields, no transfer
Depends on: R-13. Touches ENT-9.
Accept: the schema carries amount, currency, platform fee, and state; **no code
path moves money**; a test asserts that.

### R-27 Job: domain and storage
Depends on: R-2. Touches ENT-4. Split from R-7, 2026-08-21.
Accept: a Job carries draft and brief state in the domain, and it round-trips
through both storage adapters with the memory and prisma paths agreeing. No
HTTP route in this one.

### R-28 Job: draft and brief over HTTP
Depends on: R-27. Touches ENT-4. Split from R-7, 2026-08-21.
Accept: a buyer writes a brief against an agent and a repo over HTTP; a draft
exists; no job exists yet. The routes validate against R-27's domain rules
rather than restating them.

### R-29 Key rotation: domain and storage
Depends on: R-2. Touches ENT-8.4. Split from R-6, 2026-08-21.
Accept: rotation records the superseded key and when it was superseded, it
round-trips through both storage adapters, and a credential signed by the OLD
key still verifies afterwards. No HTTP route in this one.

### R-30 Key rotation over HTTP
Depends on: R-29. Touches ENT-8.4. Split from R-6, 2026-08-21.
Accept: an operator rotates an agent key over HTTP, and the e2e test verifies a
credential signed before the rotation still checks out after it.

### R-31 Stale and withdrawn job outcomes
Depends on: R-11, R-12. Touches ENT-4. Filed 2026-08-22 (answers MISSION Q3;
decision recorded in `.factory/decisions.md`).
Accept: a job whose pull request is unmerged 30 days after `submittedAt` is
recorded `stale`; a buyer can withdraw an open job, recorded `withdrawn`; a
pull request that merges AFTER the stale marker still completes the job and
issues the credential, with the outcome updated. Stale and withdrawn are
recorded facts about timing, never judgements about the work.

### R-32 Passive liveness on profiles
Depends on: R-12, R-16 (profile read model). Touches ENT-2, ENT-4. Filed
2026-08-22.
Accept: an agent profile derives Active / Quiet (>30d) / Dormant (>90d) from
OBSERVED events only: the latest of last completed hire, last recorded hire
activity, and last DID-signed API interaction. No required heartbeat: a
mandatory check-in call would make a scheduler and a hot key a listing
requirement, filtering out operators whose agent is not an always-on service,
and it proves the wrong thing anyway (a cron job pings fine while the agent
behind it is dead). An OPTIONAL signed check-in exists for agents with no
recent public activity, displayed as its own tier labelled self-reported,
never blended with observed activity (MISSION invariant 5 applied to
liveness). Never delisted, never scored: labelled.

### R-33 Buyer diversity, visible
Depends on: R-12, R-16. Touches ENT-2, ENT-4. Filed 2026-08-22.
Accept: an agent profile shows distinct-buyer count beside total hires
("12 hires · 4 buyers"), and a hire whose buyer DID and agent DID resolve to
the same operator DID is visibly labelled a self-hire everywhere it appears,
including in the counts. Self-hires are allowed (dogfooding is legitimate
evidence) and never hidden: without the label, five self-hires read as five
independent buyers, which is exactly the equivalence MISSION invariant 5
forbids. No policing, no score penalty: the label IS the mechanism, and the
economic disincentive arrives with settlement.

### R-34 DID-signed requests: agent buyers on the existing routes
Depends on: R-14, R-15, R-28. Touches ENT-1, ENT-2, ENT-4. Filed 2026-08-22.
**Human-seeded stub required before the factory builds this** (Phase-0 rule:
new subsystem, new auth path).
Accept: every hire-loop route that accepts an OAuth session equally accepts an
HTTP Message Signature (RFC 9421) signed by a registered agent or operator
DID's ed25519 key: same routes, same validation, second authentication method,
no parallel API. An e2e test drives brief -> criteria -> confirm entirely with
signed requests and no session. This is the layer that makes agents first-class
buyers; the MCP wrapper and any A2A negotiation protocol build on it later and
are OUT of this issue's scope.

---

## What is deliberately absent

Not oversights. Building any of these is out of scope per MISSION, and an issue
proposing one should be rejected at triage.

- An agent runtime, sandbox, or inference of any kind
- Dispute resolution about whether work was good
- A general freelancer marketplace, or humans for hire
- Feeds, following, or messaging beyond the hire
- Any live payment path in v1
- A public write API
