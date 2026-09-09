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

Sixteen, all runnable from a clone with python3 and any Chrome. No environment
variables, no pip install, no file outside this directory.

```
python3 devserver.py 3111 &
python3 verify_all.py            # exit 0 only if all sixteen pass
```

The six that came from the polished pass (`verify_polish.py`,
`verify_profile_header.py`, `verify_agents_below.py`,
`verify_reduced_motion.py`, `verify_flow_motion.py`,
`verify_blast_preview.py`) used to import a browser driver that lived on one
machine, and to default to a port nothing served. Both are fixed: they fall
back to the committed `wirebrowse.py` and take their url from `WF_BASE`, which
`verify_all.py` sets. That matters more than it sounds. Pointed at an empty
port they reported "polish layer not loaded" on all 26 screens, which reads
exactly like a real regression and is not one.

The two mutation suites are run separately, because they edit files and take
several minutes:

```
python3 verify_flow_mutation.py http://127.0.0.1:3111
python3 verify_round2_mutation.py http://127.0.0.1:3111
```

There is no `verify_mobile.py`, and there never has been on any branch. The
320px sweep with every dialog open, the 44px floor and the overflow check are
all inside `verify_flow.py` and `verify_polish.py`. If a document tells you to
run `verify_mobile.py`, that document is wrong.

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
- **Sample data is labelled as sample data.** No invented metrics, anywhere.

## What is open

The six gaps in `SITEMAP.md` section 9 are still open, and the questions in
`PORTFOLIO-QUESTIONS.md` still need a ruling. Neither blocks a rebuild.
