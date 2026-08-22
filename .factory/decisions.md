# Decisions

Answers that are no longer open. **A decision is asked once** (`MISSION.md`,
"Open questions"). Every node reads this file before escalating: if the answer
is here, use it and cite the ID rather than stopping for a human who already
decided.

This file is on the protected list. The factory may READ it and must never
write it. New entries arrive by human commit.

Format: ID, the answer, the date, and who decided. Where an answer came from a
conversation, it is quoted, because a paraphrase of a decision is a new
decision.

---

## D1 (answers Q1) Ranking before there are hires to rank on

**Decided 2026-08-19, Keaton, during the marketplace wireframe.**

Browse sorts by verified hires by default, descending, and the sort is a query
parameter rather than a fixed rule.

Rationale, recorded because the reasoning constrains later work: every
alternative considered was gameable. Recency rewards churn. "Relevance" against
a self-written bio ranks on marketing copy, which `MISSION.md` invariant 4
forbids scoring. Alphabetical is honest and useless. Sorting by the only thing
we actually verified is honest, and it permanently advantages whoever arrived
first, which is a real cost accepted with open eyes.

**What this binds:** an empty record shows a zero, never a "new" badge, never a
promotional placement, and never a reordering that hides it (invariant, MISSION
"Zeros render as zeros"). A second sort option may be added; it may never
become a blended score, because invariant 5 forbids merging tiers into one
number.

## D2 (answers Q2) The shape of the acceptance-criteria exchange

**Decided 2026-08-19, Temper, building against the entity spec. Held for
review at the next merge.**

Structured, not free text: a list of criteria, each a single sentence, each
independently checkable, hashed together with `hashSpec` at confirm time.

Rationale: the confirmed hash is what a credential later attests. Free text
cannot be checked criterion by criterion, so a dispute has nothing to point at.
A rich document invites the buyer to write a specification, which is the job the
agent is being hired to do.

**What this binds:** `POST /jobs` accepts the brief, returns proposed criteria,
and `POST /jobs/:id/confirm` takes the hash the buyer saw. A criterion is
immutable once confirmed; changing one is a new job, never an edit, because an
editable criterion makes the hash meaningless.

## D3 (answers Q3) When an unmerged pull request goes stale

**Decided 2026-08-19, Temper, building against the entity spec. Held for
review at the next merge.**

30 days from the pull request opening with no merge and no close. At that point
the job's outcome is recorded as `stale`, which is a THIRD outcome alongside
merged and closed, never a failure.

Rationale: the platform does not judge the work (`ENT-7.3`). A buyer who
vanishes is not the agent's defect, and a closed pull request is not evidence
the work was bad. Recording "no outcome" honestly is the only option that does
not invent a verdict.

**What this binds:** a stale row still appears on the profile, labelled, with no
credential attached. It is never deleted and never hidden, for the same reason
the unmerged row stays.

## D4 (answers Q5) The operator profile at one agent versus twenty

**Decided 2026-08-19, Temper, drawn at four agents in the wireframe. Held for
review.**

One layout, no branching: a roster table that gains sort and filter controls
only above ten agents. A single-agent operator sees the same table with one row.

Rationale: a second layout is a second thing to maintain and a second place for
the evidence tiers to be rendered inconsistently. The table is honest at one row
and still readable at twenty.

**What this binds:** the operator page never aggregates its agents' evidence
into an operator-level score. Invariant 5 again: three tiers, never merged.

---

## Still open, do NOT escalate on these

`MISSION.md` Q4 (whether a credential records the model configuration digest)
is genuinely undecided and touches what a credential asserts, which is on the
irreversible list (`FACTORY_RULES.md` §7.3). A node that needs it must plan
around it and record the assumption, never stop and never guess.

`MISSION.md` Q3 (how long an unmerged pull request stays open): ANSWERED
2026-08-22 by Keaton via Temper. 30 days after `submittedAt` the outcome is
recorded `stale`; a buyer may withdraw earlier, recorded `withdrawn`; a merge
arriving after the stale marker still completes the job and issues the
credential, because the merge is the completion event whenever it lands. Both
markers are recorded timing facts, never judgements of the work. Implemented
as R-31.
