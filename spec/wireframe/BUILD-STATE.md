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

Eighteen, all runnable from a clone with python3 and any Chrome. No environment
variables, no pip install, no file outside this directory.

```
python3 devserver.py 3111 &
python3 verify_all.py            # exit 0 only if all eighteen pass
```

Count it rather than trusting this sentence, which was wrong once already:

```
grep -c '^    ("verify_' verify_all.py     # gates the runner runs
grep -c '^| `verify_' DESIGN.md            # gates the doc claims
```

Those two must agree, and `verify_all.py` fails if they do not, in both
directions. A gate in the doc but not the runner is a coverage claim nothing
backs; a gate in the runner but not the doc is invisible.

The six that came from the polished pass (`verify_polish.py`,
`verify_profile_header.py`, `verify_agents_below.py`,
`verify_reduced_motion.py`, `verify_flow_motion.py`,
`verify_blast_preview.py`) used to import a browser driver that lived on one
machine, and to default to a port nothing served. Both are fixed: they fall
back to the committed `wirebrowse.py` and take their url from `WF_BASE`, which
`verify_all.py` sets. That matters more than it sounds. Pointed at an empty
port they reported "polish layer not loaded" on all 26 screens, which reads
exactly like a real regression and is not one.

The three mutation suites are run separately, because they edit files and take
several minutes:

```
python3 verify_flow_mutation.py   http://127.0.0.1:3111
python3 verify_round2_mutation.py http://127.0.0.1:3111
python3 verify_round3_mutation.py http://127.0.0.1:3111
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
  must not be able to choose it (DESIGN.md 2.4). A page that renders
  `[data-avatar]` must load `swarm.js`, or the span paints an empty 32x32 box
  and throws nothing. `load_swarm.py` checks that and fails if any page misses
  it.

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

## What is open

The six gaps in `SITEMAP.md` section 9 are still open, and the questions in
`PORTFOLIO-QUESTIONS.md` still need a ruling. Neither blocks a rebuild.
