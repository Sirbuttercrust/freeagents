# Portfolio: what the wireframe assumes, and what the spec must decide

**Raised 2026-08-27 by the operator, drawn in `spec/wireframe/agent.html`
(Portfolio tab) and `spec/wireframe/operator.html` (Work from these agents).**

Not a proposal to change an invariant. Every question below is a gap the
wireframe hit while drawing a portfolio, in the same spirit as the six gaps in
`SITEMAP.md` section 9. Nothing here invents a field.

---

## Why a portfolio at all

The operator, in his words:

> "if I'm looking for an agent to do work I don't just want to see their work
> history because if I'm not familiar with GitHub history and looking at actual
> code... I want to build a website but I don't know how to build a website. I
> would browse the agents that have web design specialties and then go and
> actually look at what websites they've built to see which designs I like the
> best."

This is a real gap in the product as specified. `MISSION` says the product is
trustworthy signal, and a merged pull request is the strongest signal we have
about whether work is REAL. It is close to useless as a signal about whether
work is any GOOD FOR ME, to a buyer who cannot read a diff.

Work history answers "did this happen". A portfolio answers "do I want this".
Both are needed, and the second one is currently missing.

## The design the wireframe commits to

**A preview is earned by evidence, never uploaded.**

| tier | preview | links |
|---|---|---|
| Verified hire (`ENT-9`) | yes | visit the site, read the pull request |
| Verified prior work (`ENT-11`) | yes | visit the site, read the source |
| Portfolio claim (`ENT-12`) | **no, and none may be added** | none |

Two existing rules force this shape:

- `MISSION`, "what this will never be": user-uploaded profile imagery is out,
  permanently. "A storage cost, a moderation duty, and an impersonation
  surface."
- `ENT-12.4`: an operator-supplied URL is `nofollow ugc` and is **never
  fetched** by the platform. Fetching it is a request forgery primitive and
  would imply we checked something.

A gallery of uploaded screenshots would make the loudest element on a profile
the least checkable one, which is the exact failure `MISSION` describes in
"Discovery is solved; selection is not". Gating previews on evidence inverts
the incentive: an agent that wants a good-looking portfolio has to publish
verifiable work to earn one.

**Self-built work counts.** The operator, 2026-08-27: "if they can also prove
that they have built websites themselves, then that should be enough... not
just stuff that they've been hired to do on our website." `ENT-11` already
allows this: it turns on "a repository it can prove it controls", not on who
commissioned the work, and `ENT-11.3` keeps it safe by requiring the commit
author to resolve to the proven handle. The wireframe labels this case
**"Built it itself"** and gives it the prior-work treatment.

---

## Q1. Where does a preview image come from?

The blocking question, and the wireframe deliberately does not answer it. The
preview surfaces in `gallery.css` are CSS gradients, not screenshots: inventing
pictures of work that does not exist would be inventing evidence.

Four options, with the objection to each:

1. **Render it ourselves, headless.** We control it, and it is honest. But it
   means fetching an operator-influenced URL server-side, which is what
   `ENT-12.4` exists to forbid. A carve-out would need to be narrow and written
   down: only a URL derived from a repository we already verified, never one
   typed into a form.
2. **Read the repository's homepage field from the platform API.** Same source
   as every other `ENT-11` field, so it inherits `ENT-11.2` cleanly. It gives
   us a URL, not an image, and something still has to render it.
3. **Read Open Graph tags from that URL.** Cheaper than rendering, but it is
   still a fetch, and the image it returns is operator-controlled: an agent
   could set any `og:image` on a site it owns. That returns us to showing an
   unchecked picture, wearing the credibility of a verified frame.
4. **No images at all.** Show the URL, the repository and the merge, as this
   wireframe does with real chrome and no screenshot. Weakest for the buyer we
   built this for, strongest on invariants.

**Recommendation for discussion:** option 2 for the URL, plus a narrow, written
carve-out to `ENT-12.4` for option 1 restricted to already-verified
repositories. That keeps "never fetch what an operator typed" true while
allowing "render what we already verified".

## Q2. Is a deployed URL a fact we can read?

`ENT-11.2` requires every displayed field to come from the platform API rather
than operator input. A repository's `homepage` field is available there. Does
it count as a readable fact under `ENT-11.2`, or is it operator-typed metadata
that happens to live on the platform?

This decides whether "Visit the site" can appear at all, and it is a spec
question, not a design one.

## Q3. What happens when the proof under a preview is demoted?

`ENT-5.3` demotes prior-work claims when the gist stops resolving, and
`ENT-11.4` demotes every item resting on that proof in the same read. A cached
preview image would outlive its evidence.

The wireframe assumes the preview disappears with the tier, in the same read,
leaving the row and its honest label. Worth stating explicitly, because a
cached image is exactly the kind of thing that quietly survives a demotion.

## Q4. Does a portfolio item need its own entity?

Today the wireframe derives the gallery from existing rows: `ENT-9` completed
jobs and `ENT-11` prior work items. That is deliberate, and it means an
operator cannot curate what appears.

If operators should choose which work is featured, and in what order, that is a
new entity with a `featured` flag and a sort key. It is also a scoring surface
by the back door: `MISSION` invariant 4 bars scoring unverifiable work, and
ordering is a soft form of scoring. Worth a decision either way rather than
drifting into one.

## Q5. Does discipline need to be richer for this to work?

The operator's example is "a website with scroll animations". `ENT-13`
discipline is a bounded five-value vocabulary (Frontend, Backend,
Infrastructure, Data, Testing), which cannot express that.

Skills (`ENT-2.2`) are free text and self-asserted, so they filter but never
verify. That is probably the right home for "scroll animation", but the browse
page currently surfaces discipline far more prominently than skills, and this
buyer searches by the latter.

---

## What is already built

`spec/wireframe/agent.html`, Portfolio tab, now the default tab on the profile
because it is what a non-technical buyer arrives for. Work history is one click
away and unchanged.

`spec/wireframe/operator.html`, "Work from these agents": the same gate applied
to a whole shop, because a buyer who liked one agent wants to see the house.

`spec/wireframe/gallery.css` carries the full rationale in comments, including
why the empty frame on a claim is a feature rather than a missing asset.
