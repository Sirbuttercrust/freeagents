# Design

The visual and interaction language of FreeAgents. One source of truth for
both surfaces: the marketing landing page and the marketplace application.

**Status of this file.** Normative for appearance and interaction. It sits
below `MISSION.md` and `spec/entities.md`, which win on any conflict, and
beside `SITEMAP.md`, which owns structure and flow. Where this file describes
how a tier LOOKS, `entities.md` decides what a tier IS.

**Why a design file exists at all.** The factory does not own taste
(`MISSION.md`, "What the factory does NOT own"). It does own consistency. A
written token set and a written component vocabulary let a machine build ten
screens that look like one product, while leaving every judgement about
whether the result is good to a human. This file is the boundary between
those two things.

---

## 1. The two ideas

Everything else in this file follows from these. They are co-equal, and when
they appear to conflict, idea two wins the first screen and idea one wins the
detail beneath it.

### 1.1 Evidence is the interface

This product sells the difference between a capable agent and a confident one.
Every visual decision either makes that difference legible at a glance or it
is decoration. There is no third category.

Three consequences:

1. **The accent colour means "we watched this happen."** Nothing else may use
   it. Not a call to action that wants attention, not a "featured" placement,
   not a hover state that felt flat. The moment the accent means two things it
   means nothing, and the product's core claim is the thing that stops
   reading.
2. **Unverifiable content is rendered quieter, and stripped of affordances.**
   A portfolio claim is dim grey with no link and no verify button. The
   ABSENCE of the control is the message. Saying "unverified" in words beside
   a button that looks identical teaches a buyer that the label is decoration.
3. **Zeros render as zeros.** An agent with no record shows three zeros in the
   same layout as an agent with fifty hires. No "new" badge, no promotional
   framing, no reordering to hide the space. This is `ENT-2.4` and it is a
   design rule as much as a data one.

### 1.2 Anyone can use it, from any background

The operator, 2026-08-20, and this is quoted because a paraphrase would soften it:

> "everything should be easy to read. Easy to look at. There should be space
> on the page. It should not be overwhelming. You shouldn't be bombarded with
> information on any page. You should be able to dive into detail where
> needed. But initially you should just see very simple, easy to read
> sections... the site is for people who can monetize their agents or go
> looking for agents to work for them on their project, so it shouldn't be
> filled with technical jargon but you should be able to get technical details
> if you want... anyone from any background could simply go to the site and
> sort of understand how to navigate and how to work it. They don't have to
> have a technical background. That's essential."

**Who this product is actually for, in their words, not ours:**

- someone who **built an agent and wants to make money with it**
- someone who **needs work done and wants to hire an agent to do it**

Neither of them arrived here to learn about decentralised identifiers. The
underlying machinery is real, it is the reason the product is trustworthy, and
it must never be the first thing a person reads.

**The four rules this produces**, binding on every screen:

1. **Plain language on the surface, precision underneath.** Every technical
   term has a plain-language primary and the exact term available on demand.
   See 1.3.
2. **Progressive disclosure, always.** A screen opens with the smallest set of
   things a person needs to act. Detail is one deliberate click away, never
   preloaded into the first view. "Show the technical details" is a real,
   repeated control in this product, not a special case.
3. **One job per screen.** A person should be able to say what a page is for
   in one sentence, without scrolling. If a screen has two purposes it is two
   screens.
4. **Space is a feature, and it is defended.** Empty space is not wasted; it
   is what makes the used space readable. A request to "fit more above the
   fold" is refused by default. Density is the thing that makes software feel
   like work.

**The test, applied to every screen before it is called done:** could someone
who has never heard the phrase "verifiable credential" land on this page,
understand what they are looking at, and take the next step correctly? If not,
the page is not finished, however accurate it is.

### 1.3 The vocabulary table

Plain language is the default rendering. The precise term is always reachable,
never deleted, because the precise term is what makes the claim checkable and
some of this audience will absolutely want it.

| the machine's word | what a person reads | where the exact term lives |
|---|---|---|
| DID | "your identity", "this agent's identity" | detail panel, copyable, labelled `DID` |
| Verifiable Credential | "proof of this job" / "receipt" | the credential page, and the verify view |
| `did:abt:z1Mv4…8kQx` | the agent's name and avatar | detail panel, mono, with copy |
| delegation proof | "who is accountable for this agent" | operator detail panel |
| account proof, bidirectional | "GitHub account confirmed" | proof detail, both directions shown |
| `specHash` | "what you both agreed to" | job detail, technical section |
| merge commit | "the change that shipped" | linked to GitHub |
| `ENT-*`, `R-*` ids | **never shown to a user at all** | builder notes only, wireframe only |
| Ed25519, JSON-LD, proof suite | **never on a primary path** | verify view, under "how this is checked" |

**Rules on the table itself.** A screen may not invent a plain-language term
that is not here; add it here first, so two screens never call the same thing
two names. And a plain-language term may never overstate: "confirmed" and
"proven" are reserved for things actually checked, never applied to a claim.

---

## 2. Colour

### 2.1 Tokens

Defined once, in `base.css`. **No screen may introduce a hex value.** A colour
that is not in this table does not exist in the product.

| token | value | what it is for |
|---|---|---|
| `--bg` | `#08090A` | page background |
| `--bg-1` | `#0E0F11` | a raised surface: a card, a panel |
| `--bg-2` | `#141517` | an inset surface: an input, a code block |
| `--fg` | `#F7F8F8` | primary text |
| `--fg-2` | `#9CA1AA` | supporting text, labels, metadata |
| `--fg-3` | `#666B73` | the quietest legible grey; unverifiable content |
| `--line` | `rgba(255,255,255,0.08)` | a divider that must exist |
| `--line-2` | `rgba(255,255,255,0.16)` | a border on an interactive element |
| `--accent` | `#7C7CFF` | **verified only.** See 2.2 |
| `--accent-hi` | `#9A9AFF` | accent hover |
| `--accent-fg` | `#0A0A16` | text on an accent fill |
| `--accent-dim` | `rgba(124,124,255,0.12)` | accent wash, for a verified row |

**Dark only.** There is no light theme in v1 and no token reserved for one.
Adding it later is a token-layer change, not a rewrite, because no screen
hardcodes a colour.

### 2.2 The accent is reserved

`--accent` is permitted on exactly these things:

- a verified hire row, its count, and its link to the pull request
- the credential verify affordance
- the primary action on a page, of which there is **at most one**
- a focus ring

It is forbidden on: any "featured" or "new" treatment, any count that mixes
tiers, any portfolio content, any decorative border, any hover that is not
already accent-coloured at rest.

### 2.3 The three tiers have three treatments

This table is the visual half of `DATA-CONTRACT.md` section 1 and must not
drift from it.

| tier | text colour | link | verify affordance | border |
|---|---|---|---|---|
| Verified hire | `--fg` with `--accent` marker | to the PR and the credential | **yes**, accent | none |
| Verified prior work | `--fg` | to the gist proof and the repo | **yes**, plain | none |
| Portfolio claim | `--fg-3` | none, ever | **no, and none may be added** | none |

A claim carries no border, no "pending" state, and no progress indicator. It
is not a thing that becomes verified by waiting (`ENT-12.1`).

### 2.4 The agent palette

Five hues for the animated agents, and for nothing else. They are identity,
not decoration, and they never carry meaning about evidence.

| token | value |
|---|---|
| `--agent-1` | `#7C7CFF` |
| `--agent-2` | `#58B0E8` |
| `--agent-3` | `#46C39A` |
| `--agent-4` | `#E0A24E` |
| `--agent-5` | `#E4757F` |

**Avatars are not from this palette.** An agent's avatar is generated from its
DID with `blobatar`, server-rendered (`ENT-2.3`). There is no upload path
anywhere in the product and none may be added.

### 2.5 Contrast

Every text and background pair meets **WCAG 2.2 AA**: 4.5:1 for body text,
3:1 for text at 18px+ and for the boundary of an interactive control.

`--fg-3` on `--bg` is the tightest pair in the system and it is deliberately
at the edge. It is permitted for portfolio claim text and for nothing that a
user must read to act. **If a measurement says it fails, the fix is to lift
the token, never to leave it.**

Measured with a real browser, not eyeballed. Anything reporting `lab()` or
`oklch()` must be converted before comparison; parsing those as RGB is a known
way to get a confident wrong answer.

---

## 3. Type

### 3.1 Families

| token | stack | for |
|---|---|---|
| `--font` | `"Geist", -apple-system, "Inter", "Helvetica Neue", sans-serif` | everything |
| `--mono` | `"JetBrains Mono", "SF Mono", Menlo, monospace` | DIDs, hashes, diff counts, repo paths, code |

Mono is a signal, not a style: it marks a value that is **machine-checkable**.
A DID, a commit sha, a `+412 / -88`. Prose is never mono.

### 3.2 Scale

**Three sizes in the body.** A page with seven sizes makes the eye re-measure
at every paragraph, and that re-measuring is what "busy" feels like.

| role | size | weight | tracking |
|---|---|---|---|
| h1 | 28px | 600 | -0.03em |
| h2 | 20px | 550 | -0.02em |
| h3 | 15px | 550 | -0.01em |
| body | 15px | 400 | 0 |
| supporting | 13px | 400 | 0 |
| mono | 12px | 400 | 0 |

Nothing else. A number that needs emphasis gets weight, never a new size.

### 3.3 Measure

Reading text is capped at **56ch**, supporting text at **62ch**. A full-width
line at 1080px is roughly 130 characters, which is about twice a comfortable
measure.

---

## 4. Space

`--w: 1080px` is the content width.

**Space instead of lines.** A border is a permanent mark separating two things
forever; a gap does the same work and leaves nothing behind. Every divider
that could be a gap is a gap. What survives: the single line under the
header, and row separators in a list where alignment genuinely needs a guide.

Spacing steps: **4, 8, 12, 16, 22, 34, 56**. A value outside that set is a bug.

### 4.1 The density budget

Section 1.2 is a principle; this is the number that enforces it. Applied to
the **first viewport** of any screen, before scrolling and before any detail
is expanded.

| budget | limit |
|---|---|
| primary actions | **1** |
| secondary actions | 3 |
| distinct interactive controls | 12 |
| top-level sections | 4 |
| words of body copy | ~120 |

A screen over budget is not fixed by shrinking the type. It is fixed by moving
something behind a disclosure, or by becoming two screens.

`measure_density.py` in this directory measures a live page against these
numbers, and `calibrate_density.py` compares against real reference sites so
the budget stays grounded rather than arbitrary.

### 4.2 Progressive disclosure, mechanically

Three patterns, and no others. Each has one correct use.

| pattern | use it when | never use it for |
|---|---|---|
| **detail toggle** in place | technical facts about the thing already on screen: DIDs, hashes, proof mechanics | anything a person needs in order to decide |
| **navigate to a detail page** | a subject with its own identity: a job, a credential, an agent | a handful of extra fields |
| **step rail** | a sequence with a real gate between stages, like the hire flow | a long form split up to look shorter |

Rules that bind all three:

- **The first view is complete for its own job.** Expanding detail must never
  be required to take the primary action on the screen.
- **A disclosure control says what is behind it.** "Show technical details",
  not "More". A person should never expand something to find out what it was.
- **Disclosure state is never remembered across sessions.** Everyone gets the
  simple view first, every time. A remembered expansion means a returning
  person is greeted with the dense screen the design exists to avoid.
- **Nothing important hides behind a hover.** Hover is an enhancement, never
  the only route to a fact, and it does not exist on touch.

---

## 5. Components

The vocabulary. A screen composes from this list; a screen that needs
something new adds it here first.

| component | rules |
|---|---|
| **nav** | fixed set of links, one line beneath. Never more than five items. The signed-out and signed-in variants differ only in the last item |
| **avatar menu** | the signed-in nav's last item. `<details>/<summary>`, not script: collapsed on every load with no state to forget. Holds exactly Dashboard, Settings, Sign out and nothing else may be added |
| **btn** | 40px tall, 8px radius. `btn-primary` is accent-filled and there is **at most one per screen**. `btn-sm` is 32px |
| **input** | 40px, `--bg-2` fill, `--line-2` border. 48px on a search field, which is the only exception |
| **field** | label at 13px `--fg-2`, 6px above the control |
| **tier row** | see 2.3. The tier label is always present, never inferred from position |
| **evidence line** | the single most useful thing on a card: `last merged <repo>#<pr> · <when> · <diff>`. Mono for the machine-checkable parts |
| **count group** | three numbers, three labels, never summed. "12 verified hires / 31 prior / 2 claims" |
| **fraction** | merge rate is `12 of 14`, never `86%`. A percentage hides the denominator and is unreadable when it is 1 |
| **note** | 13px `--fg-2` block for builder context. Wireframe-only; never ships |
| **empty** | states what is absent and offers the widest single relaxation. Never apologises, never invents |
| **step rail** | numbered stages for the hire flow. The current step is `--fg`, done steps `--fg-2`, future steps `--fg-3` |
| **detail toggle** | the progressive-disclosure control. Label names what is behind it: "Show technical details". Collapsed by default, every session. 13px, `--fg-2`, no border |
| **detail panel** | what a toggle reveals. Mono for machine-checkable values, each with a copy control. Never contains an action needed to complete the page's primary job |
| **plain/exact pair** | a fact shown twice: plain language as the heading, the exact value in mono beneath or behind a toggle. "GitHub account confirmed" over `did:abt:z1Mv4…8kQx` |

### 5.1 The 44px rule

Every interactive target is at least **44 x 44px**, including on the animated
agents, whose drawn radius can be as small as 12px. Their hit radius has a
22px floor for exactly this reason.

---

## 6. Motion

Full detail lives in the `scroll-tied-motion` skill. The rules that bind every
screen:

- **Everything gates on `prefers-reduced-motion`**, and the reduced state is a
  dignified static end state, never a frozen mid-animation frame.
- **One `requestAnimationFrame` for the page.** Two independent loops have no
  guaranteed order, which produces a one-frame lag that flickers on and off.
- **Any oscillator whose frequency can change at runtime must integrate its
  phase.** Recomputing from absolute time is only safe at a constant
  frequency. This is the defect that cost a full session; it is documented in
  the skill.
- Decorative layers sit **below** content and never obscure text or a control.
- Transforms render sub-pixel on a promoted compositor layer. Rounding to
  whole pixels freezes slow motion and then pops.

Durations: **120ms** for a state change on a control, **240ms** for something
entering or leaving, **800ms** for a shape morph. Nothing else.

---

## 7. Voice

Covered by the `no-ai-writing` skill, which binds every word in the product.
The parts that are specifically visual:

- **No em dashes anywhere.** Enforced: `grep -o $'\u2014' *.html *.css *.js`
  must return zero.
- **No invented facts.** No fabricated testimonial, metric, company name, or
  agent. Wireframe sample data is plausible and clearly sample; it never
  states a claim about the real world.
- Labels say what a thing is, not how it feels. "12 verified hires", never
  "trusted partner".
- An error a user sees names the thing they can do about it.

### 7.1 Write for the person, not the protocol

Section 1.2 in sentences. Every one of these is a real substitution, not an
illustration.

| do not write | write |
|---|---|
| "Your DID has been provisioned" | "Your account is ready" |
| "Bidirectional account proof verified" | "GitHub account confirmed" |
| "Issue a W3C Verifiable Credential" | "Get a receipt for this job" |
| "specHash immutable at confirm" | "Neither side can change this later" |
| "Delegation revoked" | "This agent is no longer listed under you" |
| "No credential was issued" | "This job did not ship" |
| "Ed25519Signature2020 proof present" | "Signature checks out" |

Rules behind the table:

- **Say what happened, in the order a person cares about.** Outcome first,
  mechanism second, identifier last.
- **A jargon term appears only after its plain meaning has.** First mention
  is plain, with the exact term in parentheses or in the detail panel. Never
  the reverse.
- **Never explain the machinery on a path where it is not needed.** How the
  signature works belongs on the verify view, under a heading that offers it.
  It does not belong in a confirmation message.
- **Second person, active voice.** "You approve what it will do", not "the
  criteria are approved by the buyer".
- **Numbers keep their denominator.** "12 of 14 jobs shipped", never "86%".

---

## 8. The brand mark

**Not designed yet, and deliberately not invented here.** The operator has ideas and
holds this decision.

Current state: the wordmark is set in `--font` at 15px / 560 weight with
-0.02em tracking, beside a small accent dot. That is a **placeholder that
reads as intentional**, not a logo.

When the mark exists, this section gains: the mark itself, its clear space,
its minimum size, its monochrome and single-colour variants, and the favicon
set. Until then, **no screen may ship a logo file, and no builder may generate
one.** A placeholder that is honest about being a placeholder is better than a
mark nobody chose.

---

## 9. What must never appear

Restating the failure modes a well-meaning builder adds, because every one of
these has a good-sounding argument behind it:

- **No score, rating, trust number, or letter grade.** Not a five-star
  average, not a percentage, not a computed "trust level" (`MISSION`
  invariant 5, `ENT-10.2`)
- **No badge on unverifiable work** (`MISSION` invariant 4)
- **No "new", "featured", or "rising" treatment** that dresses up an empty
  record (`ENT-2.4`)
- **No user-uploaded avatar or profile image.** Permanently out of scope: a
  platform selling verified identity must not ship a way to look like someone
  else (`ENT-2.3`)
- **No UI implying write access to a buyer's repository.** Fork and pull
  request, always, and the interface says so (`MISSION` invariant 1)
- **No password field,** anywhere. GitHub OAuth or a passkey (`invariant 8`)
- **No chain vocabulary in a required path.** ArcBlock is visible and
  explained, never a gate. "Celebrate the rails, never toll them"
  (`invariant 7`)
- **No dark pattern on a count.** If a number is small it is shown small
- **No jargon on a primary path.** A person must never need to know what a DID
  is to hire an agent or to list one. The exact terms stay available in detail
  panels; they never gate an action (section 1.2)
- **No wall of information on a first view.** Over the density budget in 4.1
  is a defect, not a preference

---

## 10. Checking a screen

Runnable, in this directory. A screen is not done until these pass.

```bash
# density budget, section 4.1
python3 measure_density.py

# against real reference sites, so the budget stays honest
python3 calibrate_density.py

# house rule: zero em dashes
grep -o $'\u2014' *.html *.css *.js *.md | wc -l
```

And three checks that are a human's, because no script measures them:

1. **The one-sentence test.** Can a person say what this page is for, without
   scrolling, without expanding anything?
2. **The no-background test.** Could someone who has never heard of a
   verifiable credential take the right next step from this screen?
3. **The tier test.** Are the three evidence tiers still obviously different
   at a glance, or has a well-meaning change made them look equivalent?
