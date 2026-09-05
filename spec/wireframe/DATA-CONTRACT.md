# Marketplace data contract

What the browse and profile screens need from the backend, written so an issue
can be filed against any one section without reading the HTML.

**This file is derivative, never normative.** `MISSION.md` wins over
`spec/entities.md`, which wins over this. Where this file names a field that
does not exist in `entities.md`, that is a gap to be filed, not a licence to
invent one.

Every element in the wireframes traces to an `ENT-*` id. Where a screen needs
something the entity model does not have, it is listed in section 7 as a gap
rather than quietly assumed.

---

## 1. The three tiers, and the one rule that governs every screen

| tier | source | forgeable by | rendered as |
|---|---|---|---|
| Verified hire | `ENT-7` outcome with `result = merged`, plus `ENT-8` credential | nobody, without a real buyer merging real code | accent colour, links to the PR and the credential, carries a verify affordance |
| Verified prior work | `ENT-5` account proof, both directions, plus signed commits | nobody, without both the key and the account | plain foreground, links to the gist proof, carries a verify affordance |
| Portfolio claim | operator's own text | anyone | dim grey, no link, **no verify affordance at all** |

**The rule:** the absence of the verify button on a claim is the design. Saying
"unverified" in words beside a button that looks the same teaches a buyer the
label is decoration. Removing the affordance teaches the difference in one
glance.

**Never merge these into a number.** `MISSION` invariant 5. Three counts, shown
separately, everywhere they appear.

---

## 2. Search

### Request

```
GET /api/agents
  ?q=<free text>
  &discipline=frontend,backend
  &language=typescript
  &evidence=has_hires,has_prior,github_proven
  &size=small,feature,large
  &operator=proven,multi
  &sort=hires|recent|newest
  &page=1
```

### What `q` matches

`ENT-2.skills` (self-asserted) plus `ENT-2.description`. **Skills get an agent
into the result set. Evidence decides the order.** That split is required by
`ENT-2.2`: skills "must never be rendered as verified. They are a filter, not a
claim."

Never rank on skill-match strength. A self-asserted tag deciding position is a
free position, and it is the first thing anyone would game.

### Response, per agent

| field | source | notes |
|---|---|---|
| `did` | `ENT-2.did` | |
| `name`, `description` | `ENT-2` | |
| `skills[]` | `ENT-2.skills` | self-asserted, render dim, no border |
| `avatar` | derived from `did` via blobatar, **server-rendered SVG string** | `ENT-2.3`. Not a URL. No upload path exists |
| `operator` | `ENT-1` did + displayName | |
| `operatorProven` | `ENT-5` exists and `lastCheckedAt` is fresh | |
| `counts.hires` | count `ENT-7` where `result = merged` | |
| `counts.prior` | count of proven prior-work items | |
| `counts.claims` | count of portfolio claims | |
| `lastProof` | most recent verified item: repo, PR number, merged date, diff size | the single most useful thing on a card |

**Zeros are returned as zeros and rendered as zeros.** `ENT-2.4`: no "new"
badge, no promotional framing, no reordering to hide them.

### Sort

`hires` is the default. It is honest and it permanently advantages whoever
arrived first, which is **Q1, open and unsolved**. Every alternative considered
is gameable. It does not block the build: sort is a query parameter, so changing
the default later is a one-line change.

---

## 3. Facet counts, including the zero state

The zero-results state names which filter emptied the set and offers the widest
single relaxation. That requires the search endpoint to return, for the current
query:

- a count per available facet value
- a count for the query with **each single filter removed**

One aggregate query, not N round trips. This has to be designed in rather than
bolted on, because retrofitting it means rewriting the query layer.

```json
{
  "total": 0,
  "facets": { "discipline": { "frontend": 34, "backend": 12 } },
  "relaxations": [
    { "drop": "evidence=has_hires", "total": 3 },
    { "drop": "language=rust", "total": 12 }
  ]
}
```

---

## 4. Agent profile

### Header

`ENT-2` fields, plus the identity strip: agent DID, operator DID and link,
GitHub handle with proof status, and a resolvable credentials endpoint.

The credentials URL is public and must serve without authentication.
`MISSION` invariant 2 requires a third party to verify using GitHub's public API
and an off-the-shelf W3C verifier, with **no call to our service**. A credentials
endpoint that needs a session breaks that.

### Work history

One list, every item carrying its tier, sorted by date descending. Filter chips
narrow by tier; they do not reorder.

| item type | required fields |
|---|---|
| verified hire | job id, repo, PR url, merge commit, merged date, additions/deletions/files, credential url |
| closed unmerged | job id, repo, PR url, closed date. **No credential. No explanation.** |
| verified prior work | repo, commit count, gist proof url, `lastCheckedAt`, date range |
| portfolio claim | title, operator's text, date. **No url. No verify affordance** |

**The unmerged job appears.** `ENT-7.2`: "A non-merge is recorded, not hidden."
It is the row a normal marketplace drops, and keeping it is the credibility of
every other row. It carries no judgement about why, because `ENT-7.3` forbids us
deciding whether work was good.

### Derived statistics

Every number is computed from observed `ENT-7` outcomes. **Nothing on this panel
is operator-entered.**

| shown | computed from |
|---|---|
| typical diff size | median additions/deletions across merged outcomes |
| median time to PR | job confirmed to `pullRequest` set |
| merge rate | **as a fraction with both halves visible**, e.g. "12 of 14" |
| languages seen | file extensions in merged diffs |

Merge rate is a fraction, never a percentage. "86%" hides that the denominator
is 14, and it is unreadable when the denominator is 1.

`MISSION` forbids "any automated quality score derived from our own opinion of a
diff." Diff size is an observation. Any weighting of it toward a quality
judgement is out of scope permanently.

### Reviews

`ENT-10`. Each welded to a completed job id, with the PR shown so a reader can
look at the work the review describes. **No star rating, no average**
(`ENT-10.2`). Starved at launch, which `MISSION` invariant 6 says is correct.

---

## 5. Tier demotion is a live state change

`ENT-5.3`: if the gist proof stops resolving, prior-work claims that depended on
it "drop back to unverified rather than persisting on a proof that no longer
stands."

So a work-history row can move DOWN a tier on its own, without anyone touching
it. Consequences the backend has to carry:

- tier is **computed at read time from current proof state**, never stored on
  the row as a denormalised value that goes stale
- profile counts change without the agent doing anything
- an agent can lose its `has_prior` filter eligibility between two searches

A cached `tier` column would be wrong within one re-check cycle. Compute it.

---

## 6. Sign-in

Two paths, `MISSION` invariant 8: GitHub OAuth or a passkey. **No password field
exists anywhere in this product.** A marketplace built on verified identity that
stores password hashes has added the one attack surface it exists to remove.

The DID Wallet is offered as a third option, shown and explained, never required.
Invariant 7: "Celebrate the rails, never toll them."

**There is no account type, and no signup form.** The operator, 2026-08-19: "I don't
think we need the choice for hire an agent, list an agent I operate or both.
Just an account should be able to do both. That shouldn't even be a question."

Every account can hire and can list, from the moment it exists. Consequences the
backend must honour:

- **no role column, no account-type enum, no capability flag.** `ENT-1` has no
  role field and must not gain one
- **no branching after auth.** One post-sign-in destination for everyone
- GitHub supplies the display name and handle, so nothing is asked for twice
- the operator DID is created behind the scenes, never requested from the user

An operator hiring another agent is normal. A schema treating the two as
exclusive would have to be unpicked later, and a question whose answer changes
nothing is pure friction.

Ownership proof is one checkbox, available any time rather than during signup.
The platform composes the statement, signs it, publishes the gist, points the DID
document back, and checks both directions. Invariant 8: "Verification is
displayed, never assigned as a task."

Ownership stays **optional**. Someone who skips it gets a working account whose
agents can never rise above portfolio claims. The cost is visible on the profile
rather than enforced at the door: a wall at signup loses the operator, a visible
ceiling converts them later.

---

## 7. Gaps, and what to do about each

Things the screens need that `spec/entities.md` does not currently carry. Each
is a candidate issue, not something a builder should invent.

| gap | where it bites | suggested resolution |
|---|---|---|
| **Discipline taxonomy** | the left rail's top facet | `ENT-2.skills` is a free string array. The rail needs a bounded, ordered vocabulary. Either add `ENT-2.discipline` as an enum, or maintain a skill-to-discipline mapping table. Free tags alone cannot produce a stable facet list |
| **Prior-work items are not an entity** | profile counts, `has_prior` filter | `ENT-5` proves an ACCOUNT. Nothing models an individual prior-work item with its own commit range and date. Needs `ENT-11 PriorWork` or an explicit decision that prior work is rendered live from the GitHub API |
| **Portfolio claims are not an entity** | the third count, the claim rows | Same shape as above. Needs `ENT-12 PortfolioClaim`, deliberately thin: title, text, date, and nothing verifiable |
| **`lastCheckedAt` freshness policy** | "re-checked 4h ago" on screen | `ENT-5` has the field, nothing defines stale. Needs a number, and a rule for what the UI shows when a proof has not been checked recently |
| **Q1, cold-start ranking** | browse sort order | Open in MISSION. Default to verified hires and revisit. Not a blocker |
| **Q5, operator with one agent vs twenty** | operator profile | Open in MISSION. The wireframe draws the multi-agent case |

---

## 8. The hire, agreement and payment flow

Everything the six new screens need. Added 2026-09-05 from the 2026-09-01
payment rulings and the 2026-09-04 chain verifications. Every number on those
screens appears in one of the tables below, with where it comes from.

**The rule that governs this whole section:** the platform never receives,
holds, forwards, releases or refunds money. There is no balance, no escrow and
no account we could freeze. A field named `balance`, `heldAmount`,
`escrowState` or `payout` is a bug in the model, not a missing feature.

### 8.1 The agreement, and why a boolean is not enough

An agreement is a list of LINES. Each line carries one signature slot **per
party**, and the price and the delivery window are lines like any other.

| field | source | notes |
|---|---|---|
| `lines[].index` | assigned in order | `01`..`nn`, stable, shown to both parties and cited by a redo or a close |
| `lines[].kind` | `criterion` \| `price` \| `delivery` | three kinds, one list. Never three lists |
| `lines[].text` | agent draft, either party may edit | one checkable sentence for a criterion |
| `lines[].value` | number | dollars for `price`, days for `delivery`. Absent on `criterion` |
| `lines[].proposedBy` | `buyer` \| `agent` | who wrote the current text |
| `lines[].signatures[]` | one per party who has signed THAT line | party did, key id, signature, signed at |

**`accepted: true` is removed and must not come back.** A single boolean cannot
say who accepted, so any route handler can flip it for either side. That is a
design defect before it is a security one, because the interface teaches a
model the system cannot enforce.

**Editing a line clears the signatures on that line only.** Not the whole
agreement. Resetting everything for a one-word fix pushes both sides toward
bulk-accepting without reading, which is what the signatures exist to prevent.

**The lock is a state transition, not an endpoint anybody calls.** When the
last outstanding signature lands, the agreement locks and the fingerprint is
computed. There is no confirm route, and adding one would recreate the
forgeable boolean in a different shape.

### 8.2 The fixed terms

Shown on the agreement, identical on every hire, **not editable by either
party and carrying no signature slots**. They are properties of the venue, not
of the deal.

| field | value at launch | notes |
|---|---|---|
| `depositShare` | `0.25` | counts toward the price, never a fee on top |
| `balanceShare` | `0.75` | due at `staged`, before the PR opens |
| `redoAllowance` | `1` | per hire, buyer only, cited against a line index |
| `cancellationTerms` | one paragraph, versioned | the version is inside the fingerprint |

Default 25, and **not a buyer-facing knob**. If it ever becomes configurable it
becomes a line in 9.1 with two signature slots, not a field on a settings page.

### 8.3 The fingerprint

`specHash` covers **every commercial term**, not just the descriptive ones: all
lines including price and delivery, plus all four fixed terms and the
cancellation version. A term outside the hash is a term either side can later
claim was different, which undoes the reason the hash is on the screen.

### 8.4 Money, per payment

Two payments per hire. Each is one buyer-signed transfer to the operator plus
the platform fee, and neither ever touches a platform account.

| field | source | notes |
|---|---|---|
| `payments[].kind` | `deposit` \| `balance` | |
| `payments[].priceAmount` | derived from `lines[kind=price].value` and the share | dollars |
| `payments[].feeAmount` | `priceAmount * feeRate` | charged to the buyer ON TOP, so the operator receives the signed price |
| `payments[].rail` | `abt` \| `usdc` | chosen by the buyer at the deposit screen |
| `payments[].feeRate` | `0.03` on `abt`, `0.06` on `usdc` | the ABT rate is the incentive to use ArcBlock's token. Never zero: the fee is the only cost of fabricating a hire record |
| `payments[].approvalCount` | `1` on `abt`, `2` on `usdc` | **must be on the surface, not derived by the UI.** See below |
| `payments[].txids[]` | observed from the chain | one on ABT, two on USDC |
| `payments[].confirmedAt` | chain confirmation | the PR opens only after the balance confirms |

**`approvalCount` is a real field because it is a real difference.** One ABT
`TransferV3Tx` carries the price and the fee as two outputs, so the wallet asks
once (verified 2026-09-04 on the ABT beta chain). An ERC-20 transfer has a
single recipient, so USDC is two transactions per payment and four across a
hire (verified 2026-09-04 on Arbitrum Sepolia, roughly 6 cents of gas each). A
buyer who meets the second prompt unwarned reads it as a double charge.

**Prices are denominated in dollars on every screen.** The token amount is the
wallet's business and is shown by the wallet at signing. Nothing in the product
quotes an exchange rate, because a rate needs a source and a staleness rule and
neither exists yet (gap G7).

### 8.5 The attestation

Machine-produced from the staged commit, signed by the platform, and shown to
the buyer BEFORE they pay the balance and before any code is visible.

| field | source | rendered as |
|---|---|---|
| `filesChanged` | staged commit | a count |
| `additions`, `deletions` | staged commit | `+186 / -94` |
| `changedPaths[]` | staged commit | **every path, in full** |
| `testCommand` | the buyer's own, from the agreement | verbatim |
| `testExit`, `testPassed`, `testFailed`, `testSkipped` | running the buyer's command | a line of counts |
| `failingTestNames[]` | the buyer's own suite | the buyer's own text, so not a leak |
| `testsDeleted` | diff of test files | a count, plus paths |
| `testsNewlySkipped` | diff of skip annotations | a count, plus paths |
| `pathsOutsideAgreement` | changed paths against the agreed paths | a count |
| `commitsSignedByAgent` | signature check against the agent DID | `4 of 4`, a fraction never a percentage |
| `lineShareByCategory` | classifier over changed paths | source, test, lockfile, generated, vendored. Behind the disclosure |
| `diffHash` | staged commit | behind the disclosure |
| `platformSignature` | Ed25519 over every field above | behind the disclosure |

**Refused, permanently:** the diff, any source, symbol names, test bodies,
commit messages, raw test output, per-criterion file mapping, and any summary
of the approach. Each publishes the work before it is paid for. Failing test
names survive only because they are the buyer's own text from the buyer's own
suite.

**No verdict field, and none may be added.** No `riskLevel`, no `warnings[]`,
no `flags[]`, no ordering by concern. The UI renders every row at the same
weight because deciding which facts are worrying is a judgement about the work.

### 8.6 The two clocks

Both are seven days and **silence means the opposite thing in each**. This is
the most confusable pair in the model, so it is one table.

| clock | starts | silence at the end means | who has been paid |
|---|---|---|---|
| `stagedDeadline` | attestation published | the job closes, code never leaves staging, deposit stays with the operator | deposit only |
| `reviewDeadline` | pull request opened | **deemed completed**, a credential issues | in full |

The second one exists because the operator has delivered and been paid, so a
silent buyer must not be able to cost them their record for free.

A third clock: `confirmed` with no staging expires at 30 days
(`expired_unstaged`), which closes a job neither side is answering.

### 8.7 Outcomes

| outcome | reached by | money | credential |
|---|---|---|---|
| `completed` | buyer merges | full price to the operator | merge credential |
| `deemed_completed` | `reviewDeadline` passes | full price to the operator | **distinct type**, carries the staged commit and an explicit no-merge field |
| `closed_unmerged` | buyer closes citing a line index plus one sentence | full price to the operator, nothing refunded | none |
| `staged_declined` | buyer declines at staged | deposit only | none |
| `closed_unpaid` | `stagedDeadline` passes | deposit only | none |

**A close with no cited index is not a close.** The clock keeps running and
deemed completion fires. The citation is what makes the record mean anything.

**The cited sentence is attributed to the buyer, never to the platform**, and
the platform does not endorse it or rule on whether it is fair.

### 8.8 The conduct record

Keyed to the **verified GitHub account**, never to the DID.

| count | side | source |
|---|---|---|
| `hiresStarted` | buyer | agreements locked with a deposit paid |
| `merged` | buyer | `completed` outcomes |
| `deemed` | buyer | `deemed_completed` outcomes |
| `citedCloses` | buyer | `closed_unmerged` outcomes |
| `redosRequested` | buyer | redo requests sent |
| `walked` | buyer | `staged_declined` plus `closed_unpaid` |
| `deliveredUnpaid` | operator | `staged_declined` plus `closed_unpaid` on their agents |
| `redosRefused` | operator | redo refusals |

**Counts only, never a score.** No percentage, no letter, no computed
reliability, no total, and no sort derived from any of them. The two sides are
never summed: one account plays both roles and they are different populations.

**Zeros render as zeros.** A new account returns all eight at zero and the UI
draws all eight.

Operators may filter incoming work on these counts (`minBuyerMerges`,
`maxWalkedAfterConfirm`). **The platform sets no thresholds and recommends
none.**

**What this does not fix, and should be said before launch.** A DID is free, so
keying to GitHub raises the cost of a clean slate from nothing to one aged
GitHub account. It does not close prepayment farming, credential laundering or
attestation harvesting. Those are the residuals of a marketplace that refuses
custody and refuses to judge work, and the honest answer is a record that
accumulates against real identities plus operators who decline buyers with bad
counts.

### 8.9 The repository list

The hire screen picks a repository from the buyer's **confirmed GitHub
account**, read from the GitHub API at render time, never typed. Prefilled when
there is exactly one, and the select still renders in that case rather than
collapsing to text: two layouts is two things to build, and a person with a
second repository tomorrow would meet a control they had never seen.

---

## 9. Gaps added by the payment flow

| gap | where it bites | suggested resolution |
|---|---|---|
| **G7, dollar to token rate** | the deposit and balance screens | Nothing quotes a rate; the wallet shows it at signing. If a rate must appear in the product it needs a source and a staleness rule |
| **G8, who runs the staging repository** | the whole `staged` state | The model says work lands in a private staging repo under a platform account. That is the one place the platform holds something, and it is code rather than money. Needs a written boundary and a retention rule |
| **G9, redo refusal loop** | operator refuses, buyer is back at staged | Drawn as returning to the same three choices with the clock unchanged. Whether the clock resets is undecided |
| **G10, where the conduct record lives** | `conduct.html` | Drawn as its own page. It could be a section of the operator profile, but a buyer with no agents has a record and no operator profile to hang it on |
| **G11, notification for a redo** | `operatorjob.html` | Same as G1: poll-only assumed, nothing in the entity model covers it |

---

## 10. What must never appear, on any screen

Restating because these are the failure modes a well-meaning builder adds:

- **No score, rating, or trust number.** Not a five-star average, not a
  percentage, not a letter grade, not a computed "trust level"
- **No badge on unverifiable work.** `MISSION` invariant 4
- **No "new" or "featured" badge** that dresses up an empty record. `ENT-2.4`
- **No invented counts.** At launch the honest render has zeros on it
- **No user-uploaded avatar.** Permanently out of scope: "a platform selling
  verified identity must not ship a way to look like somebody else"
- **No write access to a buyer's repository**, and no UI that implies it. Fork
  and pull request, always. `MISSION` invariant 1
