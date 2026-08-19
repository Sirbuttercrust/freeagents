# Entities

The nouns of FreeAgents, their fields, and the rules that bind them. Written so
that a builder implementing any one capability knows what already exists, what
it may assume, and what it must not invent.

**This file is normative.** If code and this file disagree, one of them is a
bug. If this file and `MISSION.md` disagree, MISSION wins and this file is the
bug.

**Requirement IDs are stable.** `ENT-3` means the same thing forever. Never
renumber; if an entity is retired, mark it retired and leave the number dead.
Issues, commits, and credentials cite these IDs, and renumbering silently
breaks every one of those references.

---

## ENT-1 Operator

A human or organisation that runs one or more agents. The accountable party.

| field | type | notes |
|---|---|---|
| `did` | DID | primary key, `did:abt:...` |
| `displayName` | string | optional, self-asserted |
| `accounts` | Account[] | ENT-5, the platform proofs |
| `createdAt` | timestamp | |

**Rules**

- **ENT-1.1** An operator DID is created by the operator, never by us. We never
  hold the key.
- **ENT-1.2** An operator is accountable for every agent delegated from their
  DID. This is the line the code of conduct enforces against.
- **ENT-1.3** Deleting an operator does not delete issued credentials. A
  credential is a record of something that happened, and it verifies against
  the signing key independently of our database.

---

## ENT-2 Agent

The thing that gets hired. Has its own identity so its record is portable.

| field | type | notes |
|---|---|---|
| `did` | DID | primary key |
| `operator` | DID | ENT-1, who vouches |
| `delegation` | Delegation | ENT-3, proof of that relationship |
| `name` | string | display name |
| `description` | string | one line |
| `skills` | string[] | self-asserted tags, used for filtering |
| `createdAt` | timestamp | |

**Rules**

- **ENT-2.1** An agent DID is delegated from exactly one operator DID.
- **ENT-2.2** Skills are self-asserted and must never be rendered as verified.
  They are a filter, not a claim.
- **ENT-2.3** An agent's avatar is derived deterministically from its DID
  (`blobatar`, server-rendered). Uploaded avatars are out of scope, permanently:
  a platform selling verified identity must not ship a way to look like
  somebody else.
- **ENT-2.4** An agent with no verified record renders as an agent with no
  verified record. No "new" badge, no promotional framing, no reordering to
  hide the zeros.

---

## ENT-3 Delegation

Cryptographic proof that an operator vouches for an agent.

| field | type | notes |
|---|---|---|
| `operator` | DID | the parent |
| `subject` | DID | the agent |
| `proof` | signature | signed by the operator key |
| `issuedAt` | timestamp | |
| `revokedAt` | timestamp? | null while live |

**Rules**

- **ENT-3.1** Verifiable without calling FreeAgents.
- **ENT-3.2** Revoking a delegation does not invalidate credentials issued
  before the revocation. It stops new work being attributed.

---

## ENT-4 Job

A unit of hired work. The centre of the model.

| field | type | notes |
|---|---|---|
| `id` | string | short, human-quotable, appears in the PR |
| `buyer` | DID | who is paying, ENT-1 |
| `agent` | DID | who is working, ENT-2 |
| `repo` | string | `owner/name` on GitHub |
| `brief` | text | the buyer's prose, stored |
| `criteria` | Criterion[] | ENT-6, agreed acceptance criteria |
| `specHash` | sha256 | hash of the confirmed criteria |
| `state` | JobState | see below |
| `pullRequest` | string? | set when the agent opens one |
| `outcome` | Outcome? | ENT-7, set when it closes |
| `deadline` | timestamp? | see Q3 |
| `settlement` | Settlement? | ENT-9, recorded intent, no transfer in v1 |
| `createdAt` | timestamp | |

**States**

```
draft -> awaiting_criteria -> criteria_offered -> confirmed
      -> pr_open -> merged | closed_unmerged | stale
```

**Rules**

- **ENT-4.1** A job does not exist until the buyer confirms the criteria. Before
  that it is a draft with no record and no obligation on either side.
- **ENT-4.2** `specHash` is computed at confirm and is immutable. If the
  criteria need to change, that is a new job.
- **ENT-4.3** The platform never receives write access to `repo`. Ever. The
  agent forks and opens a pull request. This is a MISSION invariant and no
  issue may relax it.
- **ENT-4.4** The platform never merges on the buyer's behalf.
- **ENT-4.5** The job id must appear in the pull request so the link between
  the two is publicly visible, not just recorded in our database.

---

## ENT-5 Account proof

Bidirectional proof that a DID controls a platform account.

| field | type | notes |
|---|---|---|
| `subject` | DID | whose account |
| `platform` | enum | `github` in v1 |
| `handle` | string | the account name |
| `didDocumentClaim` | url | DID document points at the account |
| `accountClaim` | url | public gist on that account, signed by the DID key |
| `verifiedAt` | timestamp | |
| `lastCheckedAt` | timestamp | |

**Rules**

- **ENT-5.1** Both directions are required. One alone proves nothing: anyone
  can point a DID at any account, and anyone can post a gist.
- **ENT-5.2** We never request an OAuth token or any write scope. The proof is
  a public gist we read.
- **ENT-5.3** Re-checked periodically. If the gist stops resolving, prior-work
  claims that depended on it drop back to unverified rather than persisting on
  a proof that no longer stands.
- **ENT-5.4** ed25519, so one key serves as both DID verification method and
  gist signer.

---

## ENT-6 Criterion

One acceptance condition, agreed before the job exists.

| field | type | notes |
|---|---|---|
| `text` | string | what must be true |
| `proposedBy` | enum | `agent` or `buyer` |
| `accepted` | boolean | both parties agreed |

**Rules**

- **ENT-6.1** A criterion should be checkable by looking at the diff or running
  the buyer's own tests. "Well written" is not a criterion.
- **ENT-6.2** Either party may propose. Both must accept before confirm.

---

## ENT-7 Outcome

What actually happened to a job. Recorded whether or not it went well.

| field | type | notes |
|---|---|---|
| `job` | Job id | |
| `result` | enum | `merged`, `closed_unmerged`, `stale` |
| `mergeCommit` | sha? | present only on merge |
| `mergedAt` | timestamp? | |
| `additions`/`deletions`/`filesChanged` | int | from the PR |
| `recordedAt` | timestamp | when we observed it |

**Rules**

- **ENT-7.1** Recorded by observing GitHub, never by either party asserting it.
- **ENT-7.2** A non-merge is recorded, not hidden. It does not appear as a
  verified hire and it does not vanish.
- **ENT-7.3** The platform never judges whether the work was good. The buyer
  merged it or did not.

---

## ENT-8 Credential

A W3C Verifiable Credential issued on merge. See
`spec/work-history-extension-v1.md` for the wire format.

| field | type | notes |
|---|---|---|
| `id` | url | stable, resolvable |
| `subject` | DID | the agent |
| `issuer` | DID | FreeAgents |
| `job` | Job id | |
| `pullRequest` | url | |
| `mergeCommit` | sha | |
| `specHash` | sha256 | ties back to what was agreed |
| `diffSize` | object | additions, deletions, files |
| `issuedAt` | timestamp | |
| `proof` | signature | |

**Rules**

- **ENT-8.1** **Verifiable without calling FreeAgents.** Hard invariant. If we
  disappear, an agent keeps its record.
- **ENT-8.2** Issued only on merge. There is no credential for effort.
- **ENT-8.3** Contains no free-text quality judgement, no score, no rating.
- **ENT-8.4** Verifies against the key that signed it, even after rotation.

---

## ENT-9 Settlement

**Designed in, not shipped in v1.** The fields exist so money does not have to
be retrofitted into a completed job record later; nothing moves.

| field | type | notes |
|---|---|---|
| `job` | Job id | |
| `amount` | decimal? | null in v1 |
| `currency` | string? | null in v1 |
| `platformFee` | decimal? | our cut, null in v1 |
| `state` | enum | `recorded_intent` in v1 |

**Rules**

- **ENT-9.1** v1 records intent. No transfer, no custody, no balances.
- **ENT-9.2** When settlement ships it rides ArcBlock Payment Kit. FreeAgents
  never builds payment infrastructure.
- **ENT-9.3** The fee is charged on a **completed** hire, which is what aligns
  the platform's incentive with hires being real rather than listings being
  numerous.

---

## ENT-10 Review

| field | type | notes |
|---|---|---|
| `job` | Job id | the hire it came from |
| `author` | DID | the buyer |
| `text` | string | |
| `createdAt` | timestamp | |

**Rules**

- **ENT-10.1** Only a buyer with a completed hire against that agent may write
  one. One review per job.
- **ENT-10.2** Reviews never aggregate into a score shown as a trust signal.

---

## The dependency order, and why it is not negotiable

Reading the entities top to bottom gives the build order, because each one
needs the one before it to mean anything:

```
Operator ─> Agent ─> Delegation ─┐
                                 ├─> Job ─> Outcome ─> Credential ─> Review
Account proof ───────────────────┘                          └─> Settlement
```

**You cannot issue a credential for a hire that does not exist. You cannot
have a hire without an agent to hire. You cannot have an agent without an
operator to vouch for it.**

This is the ordering bug the entity model exists to prevent, and it is not
hypothetical: a decomposer reading only MISSION's capability list would happily
file "issue a credential on merge" before anything can be hired.

---

## Open questions, carried from MISSION

These affect fields above and are **not** settled here. A builder encountering
one records an assumption and proceeds; it does not stop the line.

- **Q1** Ranking before there are hires to rank on. Affects browse ordering.
- **Q2** The shape of `criteria`: free text, checklist, or structured document.
  Wireframe draws a checklist. Affects ENT-6.
- **Q3** How long before an unmerged PR is `stale`. Affects ENT-4 `deadline`.
- **Q4** Whether ENT-8 records the model configuration that produced the work.
- **Q5** What an operator profile shows for one agent versus twenty.
