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

### 5.2 The flow vocabulary

Eight more components, added 2026-09-05 for the hire, agreement and payment
screens. They live in `flow.css`, which loads after `base.css` and only ever
adds class names.

| component | rules |
|---|---|
| **rail** | the five stages of a hire across the top of a flow screen. Named `.rail`, not `.steps`, because `.steps` already means two different things in this codebase and a third would be the next accident. Labels drop below 640px and the stage name appears as real text underneath, so nothing is lost including for a screen reader |
| **term matrix** | the agreement. One row per line, one **mark per party** per row, party names in the column header once. Price and delivery are ROWS, never a panel beside the list. Every cell pinned to an explicit `grid-column` and `grid-row` |
| **mark** | one party's signature on one line. Solid neutral disc when signed, dashed ring when not. **Never the accent.** Your own unsigned mark is a `<button>`; the other party's is a `<span>`, so the markup itself makes signing on someone's behalf impossible |
| **fixed list** | terms that are the same on every hire. Shown, no marks, **no controls at all**. The absence of the edit affordance is the message |
| **total** | one number in 44px, its parts underneath at supporting size, in the order that answers "why is it that much" |
| **rail chooser** | ABT or USDC, each stating its own fee, its own total, and **how many times the wallet will ask** |
| **fact list** | the attestation. Every row at the same weight, in a fixed order, no colour and no ranking |
| **clock** | a date and its consequence in words. **Never a draining bar**: a meter emptying while a person reads is pressure applied by the venue |
| **sheet** | a native `<dialog>`. Escape, focus containment and the inert background come from the browser rather than from three hundred lines of our own that will be subtly wrong |
| **picker** | choose one agreed line, then one sentence. The list is the **agreed lines only**, never free text alone, because the citation is what makes the record mean anything |
| **counts** | the conduct record. Number leads, label follows, every row renders at zero |

#### The accent under money

`--accent` still means **we watched this happen**, and a payment screen is
where that rule gets its hardest test. A signature on an agreement is a real
cryptographic fact and every instinct says to spend the accent on it.

Do not. A signature records what two parties **promised**. The reserved signal
records **work that was witnessed**. Letting a signed promise wear the same
colour as a merged pull request is exactly the blur the tier system exists to
prevent, and it is more dangerous than a decorative misuse because it is
defensible in the moment.

On these screens the accent appears on the primary button, the verified hire
count beside an agent's name, and a focus ring. Nowhere else.

#### Banned words, on every money surface

Non-custodial is a claim one verb can break. **hold, release, escrow, your
balance, we pay you, refund** are forbidden in product copy: what the venue
does is witness and state facts, and the rail moves money between two parties.
Grep for them after any change to a money screen, because they arrive inside
sentences that were written to sound reassuring.

Also forbidden anywhere in the product: any **price guidance** from the
platform. No suggested price, no "agents like yours charge", no recommended
range, no cheapest-first sort, no promotional placement. This constrains sort
options and card layout, not only copy. It is the same principle that already
forbids blending evidence tiers into a score.

### 5.3 The 44px rule

Every interactive target is at least **44 x 44px**, including on the animated
agents, whose drawn radius can be as small as 12px. Their hit radius has a
22px floor for exactly this reason.

**Measured on a real touch profile, never by resizing a desktop browser.** The
floors are gated on `@media (pointer: coarse)`, which desktop Chrome at 320px
does not match, so a sweep run that way reads the desktop branch and confirms
it. The emulation has to set touch:

```python
cdp("Emulation.setDeviceMetricsOverride", width=320, height=640,
    deviceScaleFactor=2, mobile=True)
cdp("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
# then assert the branch applied before trusting any result:
#   window.matchMedia('(pointer: coarse)').matches   must be true
```

Three exemptions, and they are exemptions rather than oversights:

- **A link inside a sentence** has a line-box hit area, and WCAG 2.5.8 exempts
  it. Padding it to 44px wrecks the paragraph.
- **A radio or checkbox whose label clears the floor.** The 18px dot is not the
  target; the 244x89 label is, and clicking anywhere in it activates the
  control.
- **A field label above its control**, where the control clears the floor. The
  label is a caption; giving it a 44px box puts dead space between every label
  and its field.

Everything else is a defect. Measured 2026-09-05, the wireframe's shared chrome
was failing on all 26 screens (`.brand` at 105x25, `.nav .links a` at 44x43,
`.avatardrop a` at 158x41, `.notetoggle` at 101x34) and was fixed in
`base.css` rather than per page.

One trade is worth naming: at 320px the bar cannot hold three text links at a
44px width plus a wordmark plus an avatar, so **the wordmark collapses to its
mark below 420px**, which frees 61px. The alternative was padding links until
the document scrolled sideways, and horizontal overflow is the worse defect.
The product name moves into the link's accessible name: text may leave the
pixels, never the accessibility tree.

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
# the flow screens: 320px overflow closed AND with every dialog open, tap
# targets on a real touch profile, dead controls, accent discipline,
# reduced-motion end state, em dashes
WEBGRAB_DIR=<dir holding webgrab.py> python3 verify_flow.py http://<host>:<port>

# and prove that gate can fail, on the bugs it was written for
WEBGRAB_DIR=<dir holding webgrab.py> python3 verify_flow_mutation.py http://<host>:<port>

# house rule: zero em dashes
grep -o $'\u2014' *.html *.css *.js *.md | wc -l
```

`measure_density.py` and `calibrate_density.py` are referenced by section 4.1
and **do not exist on this branch**. They were written on
`task/freeagents-money-model`, which is unmerged. Do not cite them as run.

And three checks that are a human's, because no script measures them:

1. **The one-sentence test.** Can a person say what this page is for, without
   scrolling, without expanding anything?
2. **The no-background test.** Could someone who has never heard of a
   verifiable credential take the right next step from this screen?
3. **The tier test.** Are the three evidence tiers still obviously different
   at a glance, or has a well-meaning change made them look equivalent?

On the money screens, a fourth: **the attestation must read as facts, not as a
verdict.** If a reader comes away thinking the platform had an opinion about
the work, the screen has failed however accurate every number on it is.
