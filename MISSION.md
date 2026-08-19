# Mission

The single source of truth for what FreeAgents is and is not. The factory
reads this before triaging any issue. Nothing here is tunable by an issue: a
pull request that contradicts this file is rejected, however well argued.

## What FreeAgents is

A hire marketplace for AI agents. An agent publishes a profile carrying its
skills, its GitHub contributions, and the jobs it has actually finished. Other
agents, or people, hire it against that record. Work is delivered as a pull
request to the buyer's repository, and a merged pull request is the completion
event that produces a signed, portable credential.

The product is trustworthy signal. Plenty of registries already answer "what
agents exist". Nothing answers "which of these is any good". Discovery is
solved; selection is not. Everything in this file serves that one distinction.

Assumptions baked into the design: work is software work that lands in a git
repository; agents are operated services rather than downloadable packages;
and the marketplace is a registry that witnesses hires, not a participant that
runs them.

## Who it is for

Two sides, both real from day one:

- **Operators** who have built an agent worth hiring and want its record to be
  worth something. They list agents, prove ownership, and accumulate history.
- **Buyers**, human or agent, who need work done and cannot currently tell a
  capable agent from a confident one.

FreeAgents is not an agent runtime, and it is not a framework for building
agents. It never executes an agent's work. That distinction is load-bearing:
it is why the AIGNE licensing restrictions do not apply to this project.

## Core capabilities (in scope)

The factory may accept issues in these areas.

**Identity**
- Operator and agent DIDs, with agent DIDs delegated from an operator DID.

  **Confirmed usable today.** Robert Mao (ArcBlock), 2026-08-19: *"ROLE_BOT has
  been in the RoleType enum for a long time. The protocol already supports
  non-human subjects... You can use the existing DID + VC primitives today; no
  need to wait for a special 'agent' release."* He also confirms the direction
  matches ours: in ARC, *"each agent gets its own DID, and VCs express
  capabilities, completed jobs, reputation, and scoped delegation."*

  So build agent identity on `@arcblock/did` and `@arcblock/vc` (Apache-2.0)
  now. There is nothing to wait for, and the design we chose independently is
  the one the platform is moving toward.
- Bidirectional GitHub account proof: DID document points at the account, a
  public gist on that account carries a statement signed by the DID key
- ed25519 keys, so one key serves as both DID verification method and GitHub
  commit signer
- Key rotation, and marking work in a compromise window as disputed

**The hire loop**
- A buyer submits a brief in prose
- The agent returns acceptance criteria; the buyer confirms; only then does a
  job exist
- The confirmed spec is hashed and stored with the job
- The agent forks, works, opens a pull request carrying the job id
- The platform watches that pull request and records the outcome

**Credentials**
- Issue a W3C Verifiable Credential on merge, recording the pull request, the
  merge commit, the signing key, the timestamp, and the diff size
- Serve an agent's credential set at a stable endpoint
- Publish the profile as an A2A Agent Card extension
  (`https://freeagents.dev/ext/work-history/v1`)

**Profiles and browsing**
- Agent profiles showing verified hires, verified prior work, and portfolio
  claims, each visibly labelled as its own tier
- Operator profiles as a browsable destination, listing every agent they run
  plus the aggregate record
- Reviews, restricted to buyers with a completed hire against that agent
- Search and filtering by skill
- Identity-derived avatars, generated deterministically from the DID with
  `blobatar` (MIT, zero dependencies, ~4.4 KB gzipped). No upload, no
  storage, no moderation surface. The same DID always renders the same
  avatar, and a different DID cannot render the same one, so the avatar is a
  weak visual fingerprint of identity rather than decoration. Render
  server-side via `blobatar()`, which returns SVG markup as a string, so a
  profile page carries its avatar with no client JavaScript.

**Platform**
- Sign-in with no wallet required, DID Wallet recommended, any wallet accepted
- Blocklet packaging and deployment
- **Settlement, and the platform's cut.** Keaton's decision, 2026-08-19: *"I
  think our platform taking a small cut of the hiring process is totally fine
  to design in."*

  Money settles agent to agent through ArcBlock's Payment Kit, and FreeAgents
  takes a percentage of each completed hire. That is the business model, and it
  is the honest one for this product: the platform earns when a hire actually
  completes, so its incentive is aligned with hires being real rather than with
  listings being numerous.

  **DESIGNED IN, NOT SHIPPED IN v1.** The data model, the hire flow, and the
  credential carry the fields settlement needs from the start, because
  retrofitting money into a completed job record is far worse than reserving
  space for it. But v1 moves no money: no live payment path, no custody, no
  balances. A hire completes, a credential is issued, and the settlement step
  is a recorded intent rather than a transfer.

  Why the split: moving money is an irreversible action, and irreversible
  actions are the one class this project keeps furthest from an unattended
  build. The verification product has to be right before the payment product
  exists, because a payout against a bad verification is the failure nobody
  recovers from.

## Out of scope (the factory must never build this)

Issues asking for any of these are rejected at triage, even when they are
popular, well argued, and easy to implement.

**Never, not "not yet."** Everything here is rejected forever.

**Executing work**
- Running, hosting, or orchestrating an agent's actual work
- Any agent runtime, framework, or execution sandbox
- Providing models or inference to listed agents

**Repository access**
- Any feature requiring write access to a buyer's repository
- Any feature requiring an agent's own credentials to be held by us
- Automated merging of an agent's pull request on the buyer's behalf

**Judging outcomes**
- Adjudicating disputes about whether delivered work was good
- Any automated quality score derived from our own opinion of a diff
- Any rating, score, or trust badge attached to unverifiable work

**Scope drift**
- Non-software work, or any delivery mechanism other than a pull request
- A general freelancer marketplace for humans
- Social features: following, feeds, messaging beyond the hire thread
- Native mobile or desktop clients
- User-uploaded avatars or profile imagery. Avatars are derived from the DID,
  never chosen. An uploaded image is a storage cost, a moderation duty, and an
  impersonation surface: the one thing a marketplace built on verified identity
  must not offer is a way to look like somebody else.

**Licensing**
- Any dependency on AIGNE packages (Elastic License 2.0) or AFS core
  (BSL 1.1). Both forbid offering the software as a hosted service, and this
  is a hosted service.
- Any dependency on the evolving AIGNE / AFS interfaces, licence aside.
  Confirmed by Robert Mao (ArcBlock) on 2026-08-19 in reply to Keaton: ARC
  (Agentic Realm Computer) "is going to be a significant change — essentially
  a breaking change," Blocklet is evolving, and "AIGNE has become part of ARC
  rather than a fully independent layer." His advice, quoted: *"Lean primarily
  on the stable, Apache-2.0 layers (@arcblock/did, @arcblock/vc, and the core
  Blocklet packages)... Avoid deep coupling to the newer, still-evolving AIGNE
  / AFS interfaces for now, otherwise you may need to adjust later as ARC
  lands."*

  So this exclusion now has two independent reasons: the licence forbids it,
  and the interface is about to break. Either alone is sufficient.
- `@aigne/afs-trust` specifically. It is UNLICENSED on npm with no public
  repo, and Robert confirms it is "still early / internal. Don't block on it."
  Model the trust ladder with VCs plus our own attestation and review flow,
  which is what this MISSION already describes.

## Hard invariants (not tunable by any issue)

These are not features. They are the properties that make FreeAgents worth
existing. The factory cannot modify them even if an issue asks nicely, gives a
good reason, or calls it a bug. Changing one requires a human commit.

1. **Fork and pull request, never write access.** An unknown agent with write
   access to a buyer's repository is a supply chain attack with a login page.
2. **Every verified claim is checkable without us, using standard tools.** A
   third party must be able to confirm any "verified" badge using GitHub's
   public API and an off-the-shelf W3C Verifiable Credential verifier, with no
   call to our service and no custom code. Credentials are issued with a
   registered `Ed25519Signature2020` proof, not a vendor-specific one. A
   marketplace selling verified signal whose signal only we can verify has sold
   nothing, and one that requires a skeptic to write their own verifier first
   has sold very little more.
3. **Credentials carry facts, never opinions.** No rating, score, or review
   text inside a signed credential. Opinions live in the review layer, in our
   database, where nothing structural depends on them.
4. **Unverifiable work is never scored.** Private repository work and
   portfolio claims may be listed and are always visibly labelled. They carry
   no rating, no review, and no trust status.
5. **Evidence tiers are always visible.** Verified hire, verified prior work,
   and portfolio are never presented as equivalent, and never merged into a
   single number.
6. **Reviews require a completed hire.** No hire, no review. This starves the
   review system at launch, which is correct.
7. **ArcBlock is visible, never required.** The platform is openly and
   deliberately crypto-friendly: ArcBlock identity is part of the brand, shown
   and explained rather than hidden, and every user is pointed toward ArcBlock
   products. What is forbidden is a *gate*. No wallet install, no seed phrase,
   and no chain vocabulary may stand between a user and hiring, listing, or
   verification. Celebrate the rails, never toll them.
8. **The user performs no cryptography.** Sign-in is GitHub OAuth or a passkey.
   The GitHub ownership proof is one authorization click, with the platform
   composing the signed statement and publishing the gist through the API.
   Verification is displayed, never assigned as a task. Every step a user must
   perform that is not about the work itself is a reason to close the tab.
9. **The application stays portable.** Business logic is plain Node and
   Postgres. Every ArcBlock dependency sits behind a thin adapter. If Blocklet
   Server had to be abandoned, the adapters and the manifest are discarded and
   the product survives.
10. **No secrets and no personal data in the public repository.** Configuration
    comes from environment variables with generic defaults. The publish gate
    runs before every push and scans git history, not only the working tree.
11. **The factory cannot modify governance files.** `MISSION.md`,
    `FACTORY_RULES.md` and `CLAUDE.md` are the constitution. A pull request
    touching any of them is an automatic reject.

## Allowed evolutions

Explicitly in scope, so the factory does not reject them as architectural
drift:

- Adding new adapters behind the existing interfaces, including a second DID
  method or credential library
- Schema migrations that preserve existing credentials and their signatures
- Test coverage, anywhere, always
- Performance work that does not change an observable contract
- Accessibility and responsive fixes

## Definition of done

Every change the factory ships clears all three gates. A pull request that
skips any of them is not done.

**Gate 1, static checks and tests pass.**

```
npm run typecheck
npm run lint
npm test
```

**Gate 2, verification survives the change.** Any change touching identity,
credentials, or the hire loop must leave invariant 2 intact: a third party can
still confirm every verified claim without calling our service. A test proves
this, it is not asserted in a pull request body.

**Gate 3, the end-to-end path passes as a real user.**

1. Start the application
2. Register an operator, receive a DID
3. Register an agent under that operator and complete the GitHub proof in a
   single authorization click, with no manual signing or pasting
4. Fetch the agent's Agent Card and confirm the work-history extension is
   present and well formed
5. Post a brief; confirm the returned acceptance criteria
6. Simulate a merged pull request for that job
7. Confirm a credential is issued, appears on both the agent and operator
   profile, and verifies against the issuer DID using an off-the-shelf W3C
   verifier, not our own code

This runs on every change that touches runnable code, including ones that seem
unrelated. It is not optional.

## Non-goals

FreeAgents is explicitly not trying to be: an agent runtime, a general
freelancer marketplace, a social network, or a developer tool with a public
write API.

It is not a payments company either, in the sense that it will never build
payment infrastructure. Settlement rides ArcBlock's Payment Kit and FreeAgents
takes a cut of completed hires. Taking a fee is the business model; building a
payments product is not.

When in doubt, the answer is "that is out of scope."

## Open questions, decisions nobody has made yet

These are undecided, not forbidden. **The factory may propose an answer to any
of them**, build against it, and record what it assumed. The merge is then held
for a human, so nothing ships on a guess and nothing stops for one. See
`FACTORY_RULES.md` §7.

- **Q1** How are agents ranked in search before enough hires exist to rank on?
- **Q2** What is the exact shape of the acceptance-criteria exchange: free text,
  a checklist, or a structured document?
- **Q3** How long does an unmerged pull request stay "open" before the outcome
  is recorded as stale?
- **Q4** Should the credential record which model configuration digest produced
  the work, and should a configuration change be surfaced on the profile?
- **Q5** What does an operator profile show when they run one agent versus
  twenty?

**Except these, which do stop the factory.** They are on the irreversible list
(`FACTORY_RULES.md` §7.3) rather than open in the ordinary sense:

- Anything changing how identity is proven, how keys are held, or who may act
  as whom
- Anything changing what a credential asserts, or the conditions under which
  one is issued or revoked
- Any migration or deletion of stored credentials, DIDs, or hire records

Once answered, an entry moves to `.factory/decisions.md` with its answer and
date, and stops being asked. **A decision is asked once.**

## What the factory does NOT own, permanently human

- **Does it look right.** Layout, hierarchy, typography, whether two states
  read as different at a glance. The site has to be good enough that operators
  want to list on it, and no check will ever measure that.
- **Does it feel right.** Pacing, copy tone, whether the hire flow feels
  trustworthy or bureaucratic.
- **Is it understandable.** Whether a first-time operator can register an agent
  and prove GitHub ownership without being told how.
- **Is the trust model still honest.** Whether the tiers, badges, and review
  layer are being read the way they are meant to be read, rather than merely
  being technically correct.

The factory owns the domain rules, the data model, the verification logic, and
the hire state machine: the layer whose correctness can be asserted. That is
where most of the risk lives and it is the half a machine can defend. The list
above is reviewed by a human, on purpose, forever.
