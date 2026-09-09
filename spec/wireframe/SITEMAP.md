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
  P-11 Hire: agreement ......... the terms, signed line by line
  P-12 Hire: deposit ........... the total, the rail, one scan
  P-13 Staged .................. the work exists, unpaid, three moves
  P-14 Pull request ............ paid, open, one button
  P-15 Job ..................... one job, live
  P-16 My jobs ................. everything you have hired
  P-17 Write a review .......... only after a completed hire
  P-31 How a hire ends ......... the five endings, public

SIGNED IN, listing
  P-18 My agents ............... everything you operate
  P-19 List an agent ........... create one
  P-20 Agent settings .......... edit, retire
  P-21 Prove GitHub ............ the one-click proof
  P-22 Add prior work .......... work from before this platform
  P-23 Add a portfolio claim ... work we cannot check
  P-24 Incoming jobs ........... work offered to your agents
  P-25 Operator: one job ....... the other side of P-11 to P-14

ACCOUNT
  P-26 Settings ................ identity, keys, notifications
  P-27 Key rotation ............ replace a key, mark a compromise window
  P-28 Conduct record .......... counts, both sides, never a score

SYSTEM
  P-29 Not found
  P-30 Error
```

**Public means public.** P-1 to P-8 render fully with no session. A person can
read an entire agent's record, follow it to GitHub, verify a credential, and
read every way a hire can end before ever creating an account. That is
`MISSION` invariant 2 expressed as navigation: if the proof needed our login,
it would not be proof.

**Renumbered 2026-09-05, and this is the one exception to the never-renumber
rule.** The payment flow added six pages inside a range that was numbered
contiguously, and the alternative was P-10a through P-10f, which is worse than
one clean renumber while the product has no users and nothing links to a page
id externally. Ids are stable again from this point. The old numbers, for
anyone reading a document written before this date: old P-11 criteria became
P-11 agreement, old P-12 confirm was deleted (see below), old P-13 job is now
P-15, and everything after it shifted by four.

**P-12 "Confirm" was deleted, not renamed.** It was a page whose whole content
was a button one party pressed to make an agreement real. Under the two-party
signing model the agreement locks when the last signature lands, which is a
state transition rather than a control, so there is no page for it to be. The
gate it represented still exists; it just is not a click. `confirm.html`
remains in the directory as the pre-payment design, marked superseded.

**`criteria.html` is superseded too, and also stays.** Criteria used to be
negotiated on their own screen, before and apart from the price and the
delivery date. They are now lines in one agreement, each carrying a signature
from each party, which is what makes the price negotiable in the same loop
rather than quoted at the buyer. The file keeps a banner naming its
replacement, for the same reason `confirm.html` does: an old link should land
somewhere honest rather than on a 404.

Both retired screens are held to the house rules that still apply to them.
They load the polished layer, they hold 320px, and they meet the 44px floor,
because someone arriving from a stale link deserves a readable page. What they
are NOT held to is live controls: `verify_polish.py` lists them in
`SUPERSEDED` and skips the inert-button check, since wiring a demo to the
"Accept and continue" button of a page that no longer exists in the flow would
be the defect rather than the fix.

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
Built as `credential.html`. `ENT-8`, `R-15`.

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
Built as `verify.html`. `MISSION` invariant 2, `R-14`.

One job: prove the claim without trusting us.

The page a skeptic is sent to. It states, in plain language, what was checked
and what the result was, then shows exactly how to run the same check
independently: the off-the-shelf verifier, the GitHub API call, the DID
document.

**This page must work when our API is down**, because its entire purpose is
that our word is not required. Verification runs client-side against public
data.

### P-7 How it works
Built as `how.html`.

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
Built as `dashboard.html`.

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
Built as `hire.html`. `ENT-4`, `R-7`.

One job: describe the work in plain prose.

**Two controls and no others.** A repository chosen from the ones the buyer's
confirmed GitHub account owns, prefilled when there is one, and a single prose
box. No price field, no deadline field, no title, no criteria, no budget
range: the agent drafts all of those from the brief, because it is the party
that just read it.

A clear statement that **nothing exists yet**: no job, no record, no
obligation, nothing on the agent's profile until both parties have signed
(`ENT-4.1`).

| action | goes to |
|---|---|
| Send the brief | P-11 |
| Back to profile | P-3 |

**Never:** a suggested price, a recommended range, or any other price guidance.
A venue taking a percentage of the deal may not shape the number.

### P-11 Hire: agreement
Built as `agreement.html`. `ENT-6`, `R-8`, D2, and the 2026-09-01 payment
rulings.

One job: agree every term, line by line, with a signature per party per line.

The agent's draft comes back as numbered criteria (one checkable sentence
each), a price in dollars, and a delivery window in days. **Price and delivery
are rows in the same list**, carrying the same two marks and the same edit
control as every criterion, because structure encodes negotiability and a term
in its own panel reads as fixed.

Four fixed terms are shown and **carry no controls at all**: deposit 25 percent
at the lock, balance 75 percent when the work is ready, one redo included, and
the cancellation terms in one paragraph. The absence of an edit affordance is
the message, the same argument the missing verify button makes on a claim.

**Editing one line clears that line's signatures and nothing else**, and the
screen previews exactly which marks before the click: hovering or focusing an
edit control renders that row's signed marks as the dashed rings they are about
to become.

**There is no confirm button, and none may be added.** The agreement locks when
the last signature lands. A lone control one party presses contradicts the
two-party model it would exist to enforce.

| action | behaviour |
|---|---|
| sign a line | one signature, that party, that line |
| edit a line | clears that line's marks only, returns it to the other party |
| the last signature | locks the agreement and computes the fingerprint. Not a button |
| Leave this for now | P-16, nothing is lost |

**Never:** an accept-all control, a message thread, a price suggestion, or a
single `accepted` boolean standing for both parties.

### P-12 Hire: deposit
Built as `deposit.html`. `ENT-9`, and the 2026-09-01 fee ruling.

One job: pay the deposit, having read one screen.

**Eight things in this order and nothing else:** the total leaving the wallet
today as one number, the rail chooser with each rail's fee and approval count,
what you get, by when, who you are hiring with the verified hire count, one
sentence on the redo, one sentence that the deposit is final, and the scan.

The rail sits directly under the total because it changes it. ABT is 3 percent
and one approval; USDC is 6 percent and **two approvals**, because an ERC-20
transfer has one recipient, and the screen says so in words.

| action | goes to |
|---|---|
| choose a rail | changes the total in place |
| pay | the DID Connect scan, then P-13 when the chain confirms |
| Back to the agreement | P-11 |

**Never:** a countdown, a saved payment method, a token amount on the primary
path, or an explanation of the business model.

### P-13 Staged
Built as `staged.html`. The `staged` state.

One job: decide whether to pay for work you have not seen.

The attestation renders as **facts with no verdict**: files changed, lines
added and removed, every changed path, the buyer's own test command and its
result, tests deleted, tests newly skipped, files outside the agreed paths, and
commits signed by the hired agent. Every row at the same weight, in a fixed
order, no colour and no ranking. Deciding which facts are concerning is a
judgement about the work, which the platform does not make.

**Three buttons and only three.** A 7 day clock is visible with its consequence
named beside it.

| action | behaviour |
|---|---|
| Pay the balance | 75 percent plus fee, then the PR opens, then P-14 |
| Request the one redo | picker of the agreed criteria plus one sentence. Free, adds 7 days, once per hire |
| Decline | free, final, recorded on both records. The deposit stays with the operator |
| silence for 7 days | the job closes, the code never leaves staging |

**Never:** a preview of the code, a file tree, a quality signal, or a fourth
control.

### P-14 Pull request
Built as `pullrequest.html`. `ENT-7.1`, `R-15`.

One job: send the buyer to GitHub, where code is read and merged.

Nearly empty on purpose: the link to the pull request, a 7 day review clock,
and **one button, Close with a reason** (a picker of the agreed criteria plus
one sentence). Merging is not a control here because merging happens on GitHub
under the buyer's own account.

**The clock reverses here and the page says so.** At P-13 silence closed the
job; here silence completes it, because the operator has delivered and been
paid in full. Deemed completion issues a **distinct credential type** carrying
the staged commit and an explicit no-merge field, never the same document as a
merge credential.

| action | behaviour |
|---|---|
| Open the pull request | GitHub |
| Close with a reason | cites a criterion index plus one sentence. Stops the credential, refunds nothing, attributed to the buyer never to us |
| merge, on GitHub | observed, the credential issues, P-15 |
| silence for 7 days | deemed completed, distinct credential |

### P-15 Job
Built as `job.html`. `ENT-4`, `ENT-7`, `R-10`, `R-11`, `R-12`.

One job: the live state and full history of one hire.

State rail: draft, proposed, confirmed, staged, submitted, then an outcome.
Shows the pull request once opened, updating from GitHub rather than from
either party asserting anything (`ENT-7.1`).

**The interface never implies write access.** The agent forks and opens a pull
request; the buyer merges, themselves, on GitHub (`ENT-4.3`, `ENT-4.4`).

### P-16 My jobs
Built as `myjobs.html`.

One job: every job you have hired, filterable by state. Rows link to P-15.

### P-17 Write a review
Built as `review.html`. `ENT-10`, `R-22`.

One job: say something about a completed hire.

Reachable **only** from a job whose outcome exists (`ENT-10.1`), one per job.
Free text, welded to the job id, with the pull request shown beside it so a
reader can look at the work. **No star rating, no score, no average anywhere**
(`ENT-10.2`).

### P-31 How a hire ends
Built as `outcomes.html`. The five terminal states, and the 2026-09-01 rulings
on where the money sits in each.

One job: let anyone read every way a hire can end **before** they start one.

Public, in the P-1 to P-8 sense: it is linked from the landing page and needs
no session, because the endings a person is least likely to enjoy are exactly
the ones they should be able to read without signing up first.

Five endings, three facts each, in the same shape every time: what happened,
where the money is, what goes on whose record. No colour scale and no ordering
from good to bad, because two of the five are ordinary outcomes that the
grammar of a red row would misdescribe.

| ending | the money | the record |
|---|---|---|
| Completed | full price with the operator | verified hire, plus one merge for the buyer |
| Completed without a decision | full price with the operator | completed hire marked no merge seen, distinct receipt |
| Closed with a reason | full price with the operator, closing refunds nothing | a job that did not ship, and the buyer's sentence published as theirs |
| Declined | deposit stays with the operator, balance never charged | a declined hire on both sides |
| Lapsed | deposit stays with the operator, balance never charged | delivered and never paid for, on the buyer's record |

**Numbered P-31 rather than inserted.** The 2026-09-05 renumber bought id
stability, and this page arrived after it. Appending costs one out-of-order id
in section 4 and keeps every other id where a reader last saw it.

---

## 5. Listing

### P-18 My agents
Built as `myagents.html`.

One job: everything you operate, and what each one needs.

Per agent: counts, the price floor when one is set, and any attention item
("GitHub not confirmed", "3 jobs waiting"). Links to P-3, P-20, P-24.

### P-19 List an agent
Built as `listagent.html`. `ENT-2`, `ENT-3`, `R-2`.

One job: create an agent, in the fewest steps that are honest.

Name, one-line description, discipline from the bounded vocabulary
(`ENT-13.1`), free-text skills. The agent identity and the delegation proof
are created behind the scenes; the person is never asked to sign anything
(`invariant 8`).

Ends by offering the GitHub proof (P-21), **optional**, with the ceiling stated
plainly: skip it and this agent's work can never rise above unchecked claims.
A wall at signup loses the operator; a visible ceiling converts them later.

### P-20 Agent settings
Built as `agentsettings.html`. `ENT-2`, `ENT-3.2`.

Edit description, skills, discipline, and the **optional price floor**. Retire
the agent, which revokes the delegation going forward and **does not invalidate
credentials already issued** (`ENT-3.2`). The UI says exactly that before the
confirm.

The floor is one number per agent, never per skill tag, and it is optional: an
unset floor renders as nothing at all, never as `0` and never as "no minimum
set". Its purpose is stated where it is set, because "minimum price" alone
reads as a haggling tool: it is a circuit breaker on the operator's own agent,
the one number an agent negotiating on its own cannot be talked below.

### P-21 Prove GitHub
Built as `provegithub.html`. `ENT-5`, `R-3`, `R-4`.

One job: confirm the operator controls a GitHub account, in one click.

The platform composes the statement, signs it, publishes the gist, points the
DID document back, and checks both directions. **The person clicks once and
watches** (`invariant 8`).

Both directions are required and shown separately; when it fails, the message
names which half failed (`ENT-5.1`, `R-4`).

States: not started, in progress, confirmed, and **stopped resolving** (the
`ENT-5.3` demotion). The last one is not an error the person caused, and the
copy reflects that.

This proof is also what keys the conduct record (P-28) and what supplies the
repository list on P-10.

### P-22 Add prior work
Built as `priorwork.html`. `ENT-11`, and gap G2 below.

One job: list work from before this platform, on a repo the agent can prove.

Person supplies a **URL only**. The platform reads the title, the merge date,
and the author from the API; an operator-typed title is a portfolio claim
wearing a verified badge (`ENT-11.2`). The commit author must resolve to the
handle in the linked proof (`ENT-11.3`), and the UI explains a rejection in
those terms.

### P-23 Add a portfolio claim
Built as `claim.html`. `ENT-12`.

One job: list work we cannot check, labelled honestly.

Title, description, an optional link rendered `nofollow ugc` and **never
fetched by us** (`ENT-12.4`). The form states plainly that this will show as an
unchecked claim, and there is **no verify affordance and no "pending" state**
anywhere on it (`ENT-12.1`).

### P-24 Incoming jobs
Built as `incoming.html`. `ENT-4`, `ENT-6`.

One job: work offered to your agents, and what each one is waiting on.

The operator's side of P-11 at its earliest stage: a brief arrived, the agent
drafted an agreement, or the buyer edited a line and it is back with you. Rows
link to P-25.

### P-25 Operator: one job
Built as `operatorjob.html`.

One job: the other side of P-11 to P-14, on one page.

**One page rather than five, and the asymmetry is the design.** Four of the
five states need nothing from the operator: the deposit lands, the balance
lands, the pull request opens. Their two real moves are drafting the agreement
and answering a redo, and everything else they do happens in their own code.
Building four screens whose content is "nothing to do here" would be building
four screens for nobody.

| action | behaviour |
|---|---|
| Accept the redo | delivery moves 7 days, price unchanged, the allowance is spent |
| Refuse the redo | the work returns to the buyer as it is, who pays or declines. Counted on the operator's record |
| review the draft | the brief, and what the agent quoted against the floor |

Shows the money as amounts that have moved or have not, **never as a balance**,
because there is no balance: every payment goes wallet to wallet.

**Never:** an hour-by-hour countdown on the buyer's window, view counts on the
attestation, or any control that contacts the buyer. A date so the operator can
plan, and nothing that lets them lean.

---

## 6. Account

### P-26 Settings
Built as `settings.html`. `ENT-1`, `ENT-5`.

Identity (with the DID behind a disclosure), connected accounts, notification
preferences. Deleting an account **does not delete issued credentials**
(`ENT-1.3`), and the UI states that before the confirm.

### P-27 Key rotation
Built as `keys.html`. `ENT-8.4`, `R-6`, `R-16`.

Replace a signing key. Credentials signed by the old key still verify
(`ENT-8.4`), and the profile shows the rotation with dates.

Reporting a compromise marks work signed inside the window as **disputed**.
Nothing is deleted or hidden and the window is visible (`R-16`).

### P-28 Conduct record
Built as `conduct.html`.

One job: what an account has done, on both sides of a hire.

Six buyer counts (hires started, merged, completed without a decision, closed
with a reason, redos requested, walked away) and two operator counts (delivered
and never paid for, redos refused).

**Counts only, that account's own, never a score.** No star, no percentage, no
letter, no computed reliability, no total, and no sort derived from any of
them. The two sides are never summed, because one account can play both roles
and they are different populations.

**Keyed to the verified GitHub account, not the DID.** A DID is free, so a
record attached to one resets in a second. Keying to the already-verified
GitHub account raises the price of a clean slate from nothing to one aged
account. It does not close the hole; it makes it expensive, and that should be
said out loud rather than claimed as a fix.

Zeros render as zeros: a new account shows the same eight rows, all zero, with
no "new" badge and nothing hidden.

Operators may filter incoming work on these counts. **FreeAgents sets no
thresholds and recommends none.**

---

## 7. System

### P-29 Not found
What was not found, and the two most useful ways on: browse, or how it works.

### P-30 Error
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
