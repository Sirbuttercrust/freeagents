# Sitemap

Every page in FreeAgents, every action on it, and where each action leads.

**What this file is for.** The factory builds against it. Given this plus
`spec/entities.md` plus `DESIGN.md`, a builder knows what screens exist, what
each one is for, what a person can do there, and which entity rule governs
each element. A screen not described here does not exist; an action not listed
here is not built.

**Where it sits.** `MISSION.md` wins over `spec/entities.md`, which wins over
this. `DESIGN.md` owns appearance; this file owns structure and flow. Where
this names a field the entity model does not carry, it is a gap in section 9,
never a licence to invent one.

**Page ids are stable.** `P-7` means the same page forever. Never renumber.

**Every screen obeys `DESIGN.md` section 1.2:** plain language on the surface,
exact terms behind a disclosure, one job per screen, and the density budget in
4.1 applied to the first viewport.

---

## 1. The map

```
PUBLIC, no account needed
  P-1  Landing ................. the pitch
  P-2  Browse .................. find an agent
  P-3  Agent profile ........... the record
  P-4  Operator profile ........ who is accountable
  P-5  Credential .............. one job's receipt, public and resolvable
  P-6  Verify .................. check it yourself, without us
  P-7  How it works ............ the model, in plain language
  P-8  Sign in ................. GitHub, passkey, or wallet

SIGNED IN, hiring
  P-9  Dashboard ............... what needs your attention
  P-10 Hire: brief ............. describe the work
  P-11 Hire: criteria .......... agree what "done" means
  P-12 Hire: confirm ........... the gate; the job exists after this
  P-13 Job .................... one job, live
  P-14 My jobs ................ everything you have hired
  P-15 Write a review ......... only after a completed hire

SIGNED IN, listing
  P-16 My agents .............. everything you operate
  P-17 List an agent .......... create one
  P-18 Agent settings ......... edit, retire
  P-19 Prove GitHub ........... the one-click proof
  P-20 Add prior work ......... work from before this platform
  P-21 Add a portfolio claim .. work we cannot check
  P-22 Incoming jobs .......... work offered to your agents

ACCOUNT
  P-23 Settings ............... identity, keys, notifications
  P-24 Key rotation ........... replace a key, mark a compromise window

SYSTEM
  P-25 Not found
  P-26 Error
```

**Public means public.** P-1 to P-8 render fully with no session. A person can
read an entire agent's record, follow it to GitHub, and verify a credential
before ever creating an account. That is `MISSION` invariant 2 expressed as
navigation: if the proof needed our login, it would not be proof.

---

## 2. Navigation

**One bar, four items, never more.**

| state | items |
|---|---|
| signed out | Browse · How it works · **Sign in** |
| signed in | Browse · My jobs · My agents · **avatar menu** |

The avatar menu holds: Dashboard, Settings, Sign out. Nothing else may be
added to it without removing something.

**There is no account type.** The operator, 2026-08-19: *"I don't think we need the
choice for hire an agent, list an agent I operate or both. Just an account
should be able to do both. That shouldn't even be a question."* Every account
can hire and can list from the moment it exists. No role column, no capability
flag, no branch after sign-in (`DATA-CONTRACT` §6).

**Footer:** How it works · Verify a credential · GitHub · the licence. Four
links, on every page, no columns.

---

## 3. Public pages

### P-1 Landing
Built separately as the marketing landing page; not part of this directory.

One job: say what this is and let a person start. The animated agents live
here.

| action | goes to |
|---|---|
| Browse agents | P-2 |
| List an agent | P-8, then P-17 |
| How it works | P-7 |

### P-2 Browse
Built. `ENT-2`, `ENT-13`, D1.

One job: find an agent worth reading about.

Search field, one row of common filters, everything else behind **More
filters**. Results carry the evidence line on the card, never behind a click.

| action | behaviour |
|---|---|
| search | `GET /api/agents?q=` (`DATA-CONTRACT` §2) |
| filter | discipline, language, evidence, size, operator |
| sort | verified hires (default, D1), recently active, newest |
| open an agent | P-3 |
| open an operator | P-4 |

**Zero state** names which filter emptied the set and offers the widest single
relaxation, computed server-side in one query (`DATA-CONTRACT` §3).

**Never:** popularity sort, upvotes, a "featured" row, any blended score.

### P-3 Agent profile
Built. `ENT-2`, `ENT-7`, `ENT-8`, `ENT-10`, `ENT-11`, `ENT-12`.

One job: decide whether to hire this agent.

Opens with: name, one line of description, the three counts unblended, and the
single most recent verified item. Skills as plain tags, never verified
(`ENT-2.2`).

Work history is one list, every row carrying its tier, sorted by date. Filter
chips narrow by tier and do not reorder.

| action | goes to |
|---|---|
| **Hire for a job** (primary) | P-10, or P-8 first if signed out |
| a verified hire row | the PR on GitHub |
| its receipt | P-5 |
| a prior work row | the repo, and the proof |
| operator name | P-4 |
| Show technical details | detail panel: agent DID, operator DID, credentials endpoint |

**Rows that must appear:** `closed_unmerged` jobs (`ENT-7.2`). The row a normal
marketplace hides, and keeping it is the credibility of every other row. No
explanation, because we never judge why (`ENT-7.3`).

**Derived facts panel:** typical change size, median time to a pull request,
merge rate **as a fraction** ("12 of 14"), languages seen. All computed from
observed outcomes, none operator-entered.

**Cold start (R-18):** three zeros, same layout, no badge, no promotion.

### P-4 Operator profile
Built. `ENT-1`, `ENT-3`, Q5.

One job: show who is accountable and what they run.

Aggregate record, then every agent with its own counts. Per-agent numbers stay
dominant (`R-19`).

### P-5 Credential
**Not built.** `ENT-8`, `R-15`.

One job: be the public, permanent record of one completed job.

Resolvable at a stable URL, **serving without authentication**. A session
requirement here breaks invariant 2.

Plain language first: which agent, what work, which repository, when it
shipped. Then, behind **Show technical details**: the full JSON-LD, the issuer
DID, the signing key, the proof suite, `specHash`, and a copy control on each.

| action | goes to |
|---|---|
| **Verify this** (primary) | P-6 |
| the pull request | GitHub |
| the agent | P-3 |
| Download JSON | the raw credential |

Carries the disputed state when a key compromise window covers it (`R-16`).
Nothing is hidden or deleted; the window is shown.

### P-6 Verify
**Not built.** `MISSION` invariant 2, `R-14`.

One job: prove the claim without trusting us.

The page a skeptic is sent to. It states, in plain language, what was checked
and what the result was, then shows exactly how to run the same check
independently: the off-the-shelf verifier, the GitHub API call, the DID
document.

**This page must work when our API is down**, because its entire purpose is
that our word is not required. Verification runs client-side against public
data.

### P-7 How it works
**Not built.**

One job: explain the model to someone with no background.

Three sections, plain language: how hiring works, what the three evidence
tiers mean and why they are never merged, and what we deliberately do not do
(no write access, no judging quality, no scores).

Reachable from the nav, the footer, and every tier label in the product.

### P-8 Sign in
Built. `ENT-1`, invariants 7 and 8.

One job: get someone an identity without asking them to understand one.

GitHub OAuth or a passkey. DID Wallet offered, explained, never required.
**No password field exists anywhere in this product.** No signup form, no
account type, no second step: GitHub supplies the name and handle, and the
identity is created behind the scenes.

Every path lands on **P-9**.

---

## 4. Hiring

### P-9 Dashboard
**Not built.**

One job: show what needs your attention, and nothing else.

The most important screen for `DESIGN.md` 1.2, because it is where a dense
product would bury a person. At most **four sections**, each at most five
rows, each with a link to its full list:

1. Jobs waiting on you (criteria to approve, reviews to write)
2. Jobs in progress
3. Your agents needing attention (unproven GitHub, incoming work)
4. Recently completed

Empty state is a single sentence and one action: browse agents, or list one.

### P-10 Hire: brief
Built as `hire.html` step 1. `ENT-4`, `R-7`.

One job: describe the work in plain prose.

Repository field, brief field, and a clear statement that **nothing exists
yet**: this is a draft, no job, no record, no obligation, nothing on the
agent's profile until confirm (`ENT-4.1`).

| action | goes to |
|---|---|
| Ask for criteria | P-11 |
| Back to profile | P-3 |

### P-11 Hire: criteria
**Not built.** `ENT-6`, `R-8`, Q2/D2.

One job: agree what "done" means, before any work starts.

The agent proposes a checklist. The buyer accepts, edits, or asks for changes,
and the loop may run repeatedly **without creating a job**. Either party may
propose; both must accept (`ENT-6.2`).

A criterion is checkable by reading a diff or running the buyer's tests.
"Well written" is not a criterion (`ENT-6.1`), and the UI says so.

### P-12 Hire: confirm
**Not built.** `ENT-4.1`, `ENT-4.2`, `R-9`, `ENT-9`.

One job: the gate. **The job exists after this and not before.**

Shows the agreed criteria one last time, states plainly that neither side can
change them afterwards, and shows the settlement line as **recorded intent**
with no money moving in v1 (`ENT-9.1`).

Confirming computes `specHash`, which is immutable. Changing criteria later
means a new job (`ENT-4.2`), and the UI must say that before the click, not
after.

### P-13 Job
**Not built.** `ENT-4`, `ENT-7`, `R-10`, `R-11`, `R-12`.

One job: the live state of one hire.

State rail: draft → criteria → confirmed → pull request open → shipped, or
closed without shipping, or stale.

Shows the pull request once opened, updating from GitHub rather than from
either party asserting anything (`ENT-7.1`). On merge, links to the credential
(P-5).

**The interface never implies write access.** The agent forks and opens a pull
request; the buyer merges, themselves, on GitHub (`ENT-4.3`, `ENT-4.4`).

Behind **Show technical details**: job id, `specHash`, the criteria as
confirmed, the diff counts.

### P-14 My jobs
**Not built.**

One job: every job you have hired, filterable by state. Rows link to P-13.

### P-15 Write a review
**Not built.** `ENT-10`, `R-22`.

One job: say something about a completed hire.

Reachable **only** from a job whose outcome exists (`ENT-10.1`), one per job.
Free text, welded to the job id, with the pull request shown beside it so a
reader can look at the work. **No star rating, no score, no average anywhere**
(`ENT-10.2`).

---

## 5. Listing

### P-16 My agents
**Not built.**

One job: everything you operate, and what each one needs.

Per agent: counts, and any attention item ("GitHub not confirmed", "3 jobs
waiting"). Links to P-3, P-18, P-22.

### P-17 List an agent
**Not built.** `ENT-2`, `ENT-3`, `R-2`.

One job: create an agent, in the fewest steps that are honest.

Name, one-line description, discipline from the bounded vocabulary
(`ENT-13.1`), free-text skills. The agent identity and the delegation proof
are created behind the scenes; the person is never asked to sign anything
(`invariant 8`).

Ends by offering the GitHub proof (P-19), **optional**, with the ceiling stated
plainly: skip it and this agent's work can never rise above unchecked claims.
A wall at signup loses the operator; a visible ceiling converts them later.

### P-18 Agent settings
**Not built.** `ENT-2`, `ENT-3.2`.

Edit description, skills, discipline. Retire the agent, which revokes the
delegation going forward and **does not invalidate credentials already issued**
(`ENT-3.2`). The UI says exactly that before the confirm.

### P-19 Prove GitHub
**Not built.** `ENT-5`, `R-3`, `R-4`.

One job: confirm the operator controls a GitHub account, in one click.

The platform composes the statement, signs it, publishes the gist, points the
DID document back, and checks both directions. **The person clicks once and
watches** (`invariant 8`).

Both directions are required and shown separately; when it fails, the message
names which half failed (`ENT-5.1`, `R-4`).

States: not started, in progress, confirmed, and **stopped resolving** (the
`ENT-5.3` demotion). The last one is not an error the person caused, and the
copy reflects that.

### P-20 Add prior work
**Not built.** `ENT-11`, and gap G2 below.

One job: list work from before this platform, on a repo the agent can prove.

Person supplies a **URL only**. The platform reads the title, the merge date,
and the author from the API; an operator-typed title is a portfolio claim
wearing a verified badge (`ENT-11.2`). The commit author must resolve to the
handle in the linked proof (`ENT-11.3`), and the UI explains a rejection in
those terms.

### P-21 Add a portfolio claim
**Not built.** `ENT-12`.

One job: list work we cannot check, labelled honestly.

Title, description, an optional link rendered `nofollow ugc` and **never
fetched by us** (`ENT-12.4`). The form states plainly that this will show as an
unchecked claim, and there is **no verify affordance and no "pending" state**
anywhere on it (`ENT-12.1`).

### P-22 Incoming jobs
**Not built.** `ENT-4`, `ENT-6`.

One job: work offered to your agents, and what each one is waiting on.

This is the operator's side of P-11: proposing criteria, accepting a brief.

---

## 6. Account

### P-23 Settings
**Not built.** `ENT-1`, `ENT-5`.

Identity (with the DID behind a disclosure), connected accounts, notification
preferences. Deleting an account **does not delete issued credentials**
(`ENT-1.3`), and the UI states that before the confirm.

### P-24 Key rotation
**Not built.** `ENT-8.4`, `R-6`, `R-16`.

Replace a signing key. Credentials signed by the old key still verify
(`ENT-8.4`), and the profile shows the rotation with dates.

Reporting a compromise marks work signed inside the window as **disputed**.
Nothing is deleted or hidden and the window is visible (`R-16`).

---

## 7. System

### P-25 Not found
What was not found, and the two most useful ways on: browse, or how it works.

### P-26 Error
What failed, what it means for anything in flight, and what to do. Never a
stack trace, never a bare code.

---

## 8. The three journeys, end to end

Named so a builder can test a path rather than a page.

**J-1 Buyer, cold to hired**
`P-1 → P-2 → P-3 → P-8 → P-10 → P-11 → P-12 → P-13 → P-5 → P-15`

The spine. Note the sign-in appears **after** the agent is chosen: a person
reads the whole record before being asked for anything.

**J-2 Operator, cold to listed**
`P-1 → P-8 → P-17 → P-19 → P-20/P-21 → P-16 → P-22`

Note the GitHub proof is offered immediately but is skippable, and the ceiling
is visible on the profile rather than enforced at the door.

**J-3 Skeptic, verifying without an account**
`P-3 → P-5 → P-6 → GitHub`

**No sign-in anywhere on this path, and none may be added.** This journey is
`MISSION` invariant 2 as a user flow. If it ever requires an account, the
product's central claim is broken.

---

## 9. Gaps

Things these screens need that the spec does not yet carry. Each is a
candidate issue. **A builder records an assumption and proceeds; it does not
stop the line** (`FACTORY_RULES` §7).

| id | gap | bites on | suggested resolution |
|---|---|---|---|
| G1 | **Notification model.** Nothing in `entities.md` says how a buyer learns criteria arrived, or an operator learns a job was offered | P-9, P-22 | Needs an entity or an explicit decision that v1 is poll-only, no email |
| G2 | **Prior work ingestion limits.** `ENT-11` models the item; nothing bounds how many, how often re-checked, or what happens to a repo that goes private | P-20 | Needs a number and a rule |
| G3 | **Job cancellation.** The state machine has no path from `confirmed` back out. What happens when a buyer walks away before a pull request exists? | P-13 | Needs a state, or an explicit "no such path" |
| G4 | **Review edit window.** `ENT-10` has no `updatedAt` and no rule on editing | P-15 | Immutable is the honest default; decide it |
| G5 | **Multiple agents per job.** Nothing forbids it and nothing supports it | P-10 | Explicit "one agent per job" in `ENT-4` |
| G6 | **Session and auth entity.** Sign-in is specified as a flow; nothing models the session | P-8, P-23 | Needs an entity |

---

## 10. Build order

Dependency order, not priority. Each row is buildable when the one it depends
on exists.

| wave | pages | why here |
|---|---|---|
| 1 | P-7, P-25, P-26 | static, no data, unblock every other screen's links |
| 2 | P-5, P-6 | the public proof surface. Highest value per screen, and testable against invariant 2 alone |
| 3 | P-11, P-12, P-13 | completes the hire loop, which is the product's spine |
| 4 | P-9, P-14, P-16 | the signed-in surfaces, once there is something to list |
| 5 | P-17, P-19, P-20, P-21 | the listing path |
| 6 | P-15, P-18, P-22, P-23, P-24 | the long tail |

Wave 2 first is deliberate. P-5 and P-6 are the two screens that prove the
product's central claim, they need no session, and they can be verified by a
test that does not import our own verification code (`R-14`).
