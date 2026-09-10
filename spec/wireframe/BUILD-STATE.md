# FreeAgents wireframe: where the work is, and what is left

Rewritten 2026-09-09, when the two wireframes became one. Written for whoever
picks this up next, including a later version of me with no memory of it.
Everything here is checkable with a command.

## The one thing to know first

**This directory is the design source. Rebuilds start from branch
`task/d1-wireframe-reconcile`.**

```
git fetch origin
git checkout task/d1-wireframe-reconcile
cd spec/wireframe && python3 devserver.py 3111
python3 verify_all.py
```

For a while there were two wireframes. The late-August polished pass (identity
colour, generated swarm avatars, social-style profile headers, the portfolio
gallery, the agreement as a signature matrix, the dashboard pipeline) lived on
a branch that was never merged. Meanwhile `main` gained the September payment
flow, eight screens drawn on the EARLIER visual system, and twenty pages were
built from those. The operator ruled the polished pass is the design source.
This directory is the result: 33 screens, one visual system.

There is no other wireframe to consult. If you find one, it is older than this.

## What "one system" means here, concretely

Every screen loads `base.css` then `polish.css`. Every screen loads
`wireframe.js`, `icons.js` and `polish.js`. Beyond that a screen loads only
the layer it needs:

| layer | who loads it | what it owns |
|---|---|---|
| `market.css` | the marketplace and profile screens | agent cards, profile headers, identity colour |
| `gallery.css` | `agent.html`, `operator.html` | the portfolio, previews earned by evidence |
| `agreement.css` | `agreement.html` | the signature matrix, the lock bar, the blast preview |
| `flow.css` | the payment screens | the stage rail, the money total, the sheet, the picker |
| `pipeline.css` | `dashboard.html` | the job pipeline that moves |

**`pipeline.css` was called `flow.css` on the polished branch.** Two different
files had that one name and they share not a single selector: one draws the
dashboard's job track, the other draws the hire and payment flow. Renaming the
dashboard one is why both survive. Do not merge them.

## The gates

All runnable from a clone with python3 and any Chrome. No environment
variables, no pip install, no file outside this directory.

```
python3 devserver.py 3111 &
python3 verify_all.py            # exit 0 only if every gate passes
```

Count them rather than trusting a sentence, which was wrong here once already:

```
grep -c '^    ("verify_' verify_all.py     # gates the runner runs
grep -c '^| `verify_' DESIGN.md            # gates the doc claims
```

Those two must agree, and `verify_all.py` fails if they do not, in both
directions. A gate in the doc but not the runner is a coverage claim nothing
backs; a gate in the runner but not the doc is invisible.

**And a gate's SCOPE is derived, never named.** That is round 4's finding and
it is the reason `population.py` and `verify_coverage.py` exist.
`verify_ink.py` carried a list of eight screen names while DESIGN.md, this
file and the gate table all asserted AA of the whole set, so twenty-five
screens had never been measured against it. Nothing failed, because a list of
names cannot fail on a file it does not mention.

Nine gates carried such a list. Every one now computes its population from the
directory, and `verify_coverage.py` fails any gate that goes back to naming
screens. The general 320px sweep is the COMPLEMENT of the payment sweep rather
than a second list, so a screen added next month is measured by default
instead of forgotten by default.

**Round 5 found the same defect one layer down, inside that gate.**
`verify_coverage.py` inspected assignments whose value is a literal list, and
four gates passed it while each measuring one hardcoded page, because none of
them bound a list: `verify_rail` and `verify_blast_preview` wrote the page
into a `goto`, `verify_flow_motion` into a `URL` constant, `verify_pickers`
into a list of tuples the detector read as empty. All four printed "no screen
loop" in the coverage table, which reads as "no population to derive" and
meant "a population of one that nothing can see".

Each of the four now derives its screens from the markup its own assertion
needs (the rail radio, the signature chip, the travelling spark, the picker
list), and each refuses to pass on an empty population rather than iterating
zero times in silence. `verify_coverage.py` walks the whole syntax tree, so an
inline name fails the same way a list does, with an `INLINE_WITH_REASON` table
beside the existing one for the cases that are genuinely a fact about one page
rather than a scope decision. `verify_round5_mutation.py` restores each of the
four to the exact shape it shipped in and asserts the gate names both the file
and the reason, because a mutation caught for the wrong reason proves nothing.

**Round 6 found the same defect one layer OUT.** Every gate above measures the
screens, and nothing in this directory read the normative document. Review
planted `#FF00FF` in `DESIGN.md`'s token row for `--fg-3` and five gates read
straight past it, because a rendered page cannot tell you the document
describing it is wrong.

It was not hypothetical. That row held `#666B73` while `base.css` has shipped
`#7C828C` since August, and section 2.5 reasoned from the stale value in prose:
it said the token fails AA at 12 and 13px and therefore paints no characters on
the flow screens. Measured, it clears AA on all three surfaces and paints 268
character runs across the set. A stale hex is one wrong fact. A paragraph
reasoning from a stale hex sounds authoritative and sends the next builder
somewhere false, and the rebuild cards are told to read that file as the design
source.

`tokens.py` derives BOTH sides, so neither is a list: the shipped set is every
`:root` block in every stylesheet here, the documented set is every row of the
document's own table shape. `verify_designmd.py` compares them and checks three
kinds of claim, a token value, a contrast ratio and a duration, plus one
guarantee that found most of the rest: a shipped token that is neither
documented nor excluded with a written reason fails.

That last check is why this was more than one hex. The tree ships **45 tokens
and the document named 19**. The pane surface recipe (seven tokens carrying the
polished pass's whole look), the three evidence-tier tokens, the five
discipline tints, `--eye` and `--sig-open` had no row anywhere, while section
2.1 says a colour not in the table does not exist in the product. Sections 2.5,
2.6 and 2.7 now carry them, and every ratio in those tables is **recomputed on
each run** rather than typed.

Two more corrections came from the gate rather than from a reviewer. Section 6
named 120, 240 and 800ms and finished "Nothing else" while the tree ships
seventeen durations and 800ms appears nowhere. Section 4.1 said
`measure_density.py` is "in this directory" while section 10 of the same file
said it does not exist on this branch.

`verify_round6_mutation.py` carries eight controls. Two are worth knowing about
before you trust the gate:

- **B mutates `base.css`, not the document.** The defect is a DISAGREEMENT and
  either side can be the one that moves. A gate that only watches the document
  goes green the next time a token is lifted in a stylesheet and not written
  down, which is exactly how this arrived.
- **F plants a stale ratio in a TABLE CELL.** The first version of this gate
  read only the prose sentence, so moving the numbers into a table dropped its
  ratio coverage to zero while it went on printing PASS. If F ever stops
  failing, the ratios in 2.5 are unchecked again.

Control H caught a vacuous check in this gate's own first draft: the
script-exists test excused a name when an absence phrase appeared within 400
characters, and the phrase excusing the planted defect was in the sentence
describing that very gate. It checks per SENTENCE now. A window is a guess
about where a qualifier lives; the sentence making a claim has to carry it.

The six that came from the polished pass (`verify_polish.py`,
`verify_profile_header.py`, `verify_agents_below.py`,
`verify_reduced_motion.py`, `verify_flow_motion.py`,
`verify_blast_preview.py`) used to import a browser driver that lived on one
machine, and to default to a port nothing served. Both are fixed: they fall
back to the committed `wirebrowse.py` and take their url from `WF_BASE`, which
`verify_all.py` sets. That matters more than it sounds. Pointed at an empty
port they reported "polish layer not loaded" on all 26 screens, which reads
exactly like a real regression and is not one.

The mutation suites are run separately, because they edit files and take
several minutes:

```
python3 verify_flow_mutation.py   http://127.0.0.1:3111
python3 verify_round2_mutation.py http://127.0.0.1:3111
python3 verify_round3_mutation.py http://127.0.0.1:3111
python3 verify_round4_mutation.py http://127.0.0.1:3111
python3 verify_round5_mutation.py
python3 verify_round6_mutation.py
```

`verify_round3_mutation.py` is the one to read if you are wondering why the
tap-target probe is shaped the way it is. It carries the reviewer's own three
positive controls as permanent mutations, plus three more: a 20x20 button in a
visible body (which the old probe already caught), the same size as a `select`
and as a text input (which it did not, because the selector was `a,button`), a
20x20 button inside the closed facet drawer (which it did not, because it
opened no state), the real `.drawer label` floor removed, and a real em dash
planted in a file outside the payment screens. Each planted control is asserted
ALIVE at 20x20 with `(pointer: coarse)` true before its gate runs, so a
mutation that silently failed to apply cannot read as a gate catching
something.

**Start them on a clean tree, and check `git status` if one reports
`reverted: FAIL`.** They snapshot the files they mutate at startup and restore
to that snapshot, so a tree that already carries a mutation gets it written
back, and the failure looks like a broken gate rather than a dirty tree. A run
killed mid-mutation leaves `.mutation-in-progress` naming the affected files;
the next run refuses to start while it exists. If you find one:

```
git checkout -- spec/wireframe/base.css spec/wireframe/polish.css   # or whatever it names
rm spec/wireframe/.mutation-in-progress
```

`verify_flow_mutation.py` now warns at startup when the files it mutates are
dirty, which turns that confusing red run into one line.

There is no `verify_mobile.py`, and there never has been on any branch. The
320px sweep with every dialog open, the 44px floor and the overflow check are
all inside `verify_flow.py` and `verify_polish.py`. If a document tells you to
run `verify_mobile.py`, that document is wrong.

**The tap-target floor is measured on BOTH axes, in EVERY reachable state, on
every kind of control. It took three rounds to get there, and the shape of
those rounds is the lesson.**

Round 1: `verify_polish.py` read only `height`, so a control 20px wide and
44px tall passed. 13 real failures stood behind that green gate, including the
`edit` control that reopens a signed line of a paid agreement.

Round 2 fixed the axis and left the SELECTOR and the state coverage untouched.
Three probes in the tree each read `querySelectorAll('a,button')`, so no
`input`, `select`, `textarea` or `label` was ever measured, and no gate opened
a disclosure or a drawer before reading. 12 more real failures stood behind
that: eleven facet checkboxes in browse's drawer and a settings toggle.

Round 3 moved the probe into `tapfloor.py` and had the gates import it. One
selector list, one set of exemptions, one definition of which states get
opened. `verify_polish.py` now prints how many states it opened per screen,
because a gate that opens nothing reports a clean page in both the broken and
the fixed state.

Five rules follow, and none is optional:

- A floor written as `min-height` alone is not a floor. Set both axes.
- A floor written in a stylesheet that some screens do not load is not a floor
  either. The `.act` and `.steps li a` floors lived in `agreement.css`, which
  `criteria.html` and `confirm.html` do not load, so `SITEMAP.md` claimed a
  standard those two screens did not meet. Shared floors belong in
  `polish.css`, which all 33 screens load.
- A property some pages override is not a floor. `polish.css` carried
  `.drawer label { padding: 10px 0 }` and it never once applied, because
  `browse.html` defines `.drawer label` in its own `<style>` and a page-local
  rule wins at equal specificity.
- An EXEMPTION is a statement that some other element meets the floor, so
  that element has to meet it. `DESIGN.md` 5.3 exempts a checkbox whose label
  clears the floor and names a 244x89 label as the case; the code read it as
  any checkbox inside any label, which excused a 292x29 one.
- A gate that measures one state measures its own fiction. The card's
  constraint is "320px with every open state", and for two rounds the
  instrument covering 27 of the 33 screens opened none.

A page-local rule beats a linked stylesheet at equal specificity, so
`browse.html` carries its own copy of the pager floor and the drawer label
floor. If you define a component inside a page's `<style>`, its touch floor
goes there too.

## Serving it

Any static file server works. There is no build step. `devserver.py` is
committed here and is the one to use: it is threading, it sends no-cache, and
it exposes `/healthz` saying which tree is being served.

```
cd spec/wireframe && python3 devserver.py 3111
```

Bind `0.0.0.0`, never `127.0.0.1`, if anyone else needs to see it. A loopback
bind answers curl on the serving machine with a 200 and is invisible from
every other device, which is the most confusing possible failure.

## What is settled, and must not be quietly undone

- **Two signatures per line, and no confirm button.** The agreement locks when
  the last signature lands. That is a state transition to show, not a control
  to design. A lone button one party presses contradicts the model it would
  exist to enforce.
- **Price and delivery are rows in the same list as the criteria**, carrying
  the same two signatures and the same edit control. A term in its own panel
  reads as fixed whatever the copy says.
- **Editing one line clears that line's signatures only**, and hovering the
  edit control previews exactly which marks are about to go.
- **The four fixed terms carry no controls at all.** The absence of the
  affordance is the message.
- **One money model**, the 2026-09-01 ruling: price $1,200, deposit 25 percent,
  balance 75 percent, ABT 3 percent and one approval, USDC 6 percent and two.
  `verify_money.py` fails any figure that does not derive from it.
- **Nothing on any screen has the platform running, scoring or reviewing an
  agent's work.** The attestation is facts only.
- **Sample data is labelled as sample data**, on every screen that shows any.
  Twenty-five of the thirty-three carry an invented name or a dollar figure,
  and `wireframe.js` puts the marker in the builder-notes layer of all of
  them. It is injected once in the shared chrome rather than written per page,
  because the per-page version was the reason this sentence was false when it
  was first written: five screens said so and twenty did not.
  `verify_sampledata.py` is the instrument, and it defines "shows sample data"
  by reading the rendered text rather than by naming a list of pages.
  No invented metrics, anywhere.
- **Every avatar in the set is generated from the DID.** One hook,
  `[data-avatar="did:abt:<name>"]`, painted by `polish.js` through
  `FASwarm.avatar`. There is no flat placeholder disc left in the tree and no
  new one should appear: an avatar is an identity fingerprint, so an operator
  must not be able to choose it (DESIGN.md 2.4). That sentence was written
  when it was true only of the `.who` identity line, while eight screens still
  drew an inline `<circle fill="#3A3A4A">` in the account menu. It is now true
  of the set, and it is checked rather than asserted: `verify_designmd.py`
  fails on any opaque colour a screen paints, which is the shape a placeholder
  disc has to take. A page that renders
  `[data-avatar]` must load `swarm.js`, or the span paints an empty 32x32 box
  and throws nothing. `load_swarm.py` checks that and fails if any page misses
  it.

## The scope claim that was wrong, and the gate that replaced it

Round 4 found that `verify_ink.py` measured 8 of 33 screens while this file,
DESIGN.md and the gate table all asserted AA of every screen. Twenty-five
screens had never been opened by it. Nothing failed, because a list of names
cannot fail on a file it does not mention.

Widening that list would have been the same mistake the three previous rounds
made: round 1 fixed an axis, round 2 fixed a selector, round 3 fixed the open
states, and each time the identical defect was already sitting elsewhere in a
different shape. So the fix is `population.py` plus `verify_coverage.py`: a
gate declares the RULE that decides its scope, and a gate that names screens
fails.

Widening the sweep then found three instrument bugs in `verify_ink.py`
itself, each of which had been producing confident wrong numbers on the
screens it had never looked at:

| what it did | what it reported | the truth |
|---|---|---|
| collected text whose ANCESTOR was at opacity 0, mid scroll-in reveal | a badge at 1.01 against the page background | 5.79 against its own fill |
| force-opened the account menu, an absolutely positioned panel, over the page | a primary button at 1.03 against the panel | 5.79, and nobody sees both at once |
| sampled the last pixel of a text run, which sits on the pane's 1px rim | the agreement's `$300 of $1,200` at 3.64 | 6.95, confirmed by hand arithmetic from the tokens |

All three are the same error: photographing a composite of surfaces a person
never sees together. The gate now reveals the scroll-in content, waits until
two reads of the layout agree that nothing is moving, opens in-flow
disclosures together and each overlay panel alone in its own scope, and insets
its samples two pixels from the run's edges.

Two counts are printed on the face of the report for the same reason
`verify_polish.py` prints its opened-state count: `states opened` and `content
still hidden after the reveal`. A gate that reveals nothing and a gate that
reveals everything otherwise produce the same green result.

## The claim that was wrong, and the gate that replaced it

The first version of this file said nothing was lost in the reconcile, and
backed it by comparing FILE lists: every file on either parent branch exists
here. That was true, and it was the wrong claim. A file survives while an
element inside it leaves, and two did: the September agreement's technical
disclosure, and the brand's accessible name on four screens.

`verify_kept.py` is the rerunnable version of the review that caught them. It
asks Chrome for the brand's computed accessible name on all 33 screens, and
searches rendered text with every disclosure opened for facts that must still
exist somewhere in the set. Facts are tiered: a `buyer` fact demoted into the
builder notes fails, because a person using the product never opens them.

If you move a fact to a better home, the gate follows you. If you drop one, it
stops you. Add a row to `FACTS` whenever a screen gains something a person
would be misled by its absence.

## The two parties, and the name that was on both sides

The sample cast is one agent, one operator and one buyer:

| role | name | where you see it |
|---|---|---|
| the agent | `axiom-ui` | every screen in the hire flow |
| its operator, paid for the work | `northsound.dev` | `operator.html`, and every "operated by" line |
| the buyer, who commissions and pays | `northline.dev` | the `northline/*` repositories, and the brief on `operatorjob.html` |

That took a fix. Six screens said `axiom-ui` was "operated by northline.dev"
and `deposit.html` said the buyer's money went "straight from your wallet to
northline.dev", which paid the buyer their own money and put one party on both
sides of a two-party agreement. Both parent branches did it, so it arrived as
inherited rather than introduced, and it survived three rounds of review
because every gate asked whether a link RESOLVES and none asked whether it
tells the truth about where it goes.

It was not a naming preference needing a ruling. The tree settles it:
`hire.html` offers `northline/design-tokens` as one of "the four public
repositories on YOUR confirmed GitHub account", so northline is the buyer.

`verify_linknames.py` is the rerunnable version. It reads what each destination
page calls itself and fails any link whose text claims otherwise, so renaming
the operator stays a one-file change. `conduct.html` is excused by name with
the reason attached: it shows one account acting as both buyer and operator,
which is that screen's whole subject.

## What is open

The six gaps in `SITEMAP.md` section 9 are still open, and the questions in
`PORTFOLIO-QUESTIONS.md` still need a ruling. Neither blocks a rebuild.

The **$1,200 price** on the agreement is still unsigned. It is a number a
person has to choose, not one a builder can derive, and it is the one thing on
these screens waiting on the operator.
