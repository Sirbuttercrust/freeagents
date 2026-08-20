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

## 8. What must never appear, on any screen

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
