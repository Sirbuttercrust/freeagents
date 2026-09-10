# The wireframe

A complete static wireframe of the FreeAgents platform: 33 screens, every
action, every transition. This is the skeleton the factory builds against.

## Status

**One set, on the polished visual system.** This directory is the reconcile of
two branches that had drifted apart: the late-August polish pass (identity
colour, generated avatars, social-style profile headers, the portfolio gallery,
the agreement as a signature matrix, the dashboard pipeline) and the September
payment flow (agreement, deposit, staged, pull request, outcomes, incoming,
operator job, conduct). The polished pass is the design source, and the eight
payment screens were restyled onto it. `BUILD-STATE.md` names every conflict
and which way it went.

The page set, the flows, the actions on each screen, and the entity rules each
element traces to are settled and safe to wire a backend against.

**The money model is the 2026-09-01 ruling and it is applied**: price $1,200,
deposit 25 percent, balance 75 percent, ABT 3 percent with one approval, USDC
6 percent with two. `verify_money.py` fails any figure on any screen that does
not derive from it. The one open question is the $1,200 price itself, which
needs a decision from the operator and is flagged in `BUILD-STATE.md`.

Gates hold the work. The count is not written here on purpose, because a number
in prose is a claim nothing checks: `verify_all.py` prints it, and it fails if
its own list and the `DESIGN.md` table disagree in either direction.

## What is in here

| file | role |
|---|---|
| `SITEMAP.md` | every page with a stable `P-*` id, its one job, its actions, three end-to-end journeys, six named spec gaps, and a dependency-ordered build plan |
| `DESIGN.md` | the visual and language system: tokens, the three-tier evidence treatment, a plain-language vocabulary table, a density budget, disclosure patterns, and the gate table |
| `DATA-CONTRACT.md` | what each screen needs a backend to supply, mapped to `spec/entities.md` |
| `BUILD-STATE.md` | where the current work stands, how to serve it, how to run the gates, and what is left |
| `*.html`, `base.css`, `wireframe.js` | the screens. Static, no build step, sample data only |
| `polish.css`, `polish.js`, `icons.js` | icons, interactions, scroll spy, toasts, dialogs |
| `market.css` | profiles, the browse grid, identity hues, category tints, evidence badges |
| `gallery.css` | the portfolio gallery and its evidence gate |
| `agreement.css` | the two-party signing matrix, price terms, lock meter |
| `flow.css`, `flow.js` | the payment screens: rails, pickers, the scan sheet |
| `pipeline.css` | the dashboard pipeline rail |
| `perch.js`, `agents.js`, `swarm.js` | the decorative animated agents, and the DID-derived avatar engine |
| `verify_*.py` | the gates. Standard library only, no environment to set up |
| `measure_*.py`, `probe_ink.py`, `load_swarm.py` | scratch instruments that print numbers rather than asserting them |
| `wirebrowse.py`, `devserver.py` | the browser driver and the preview server, both committed so a reviewer with a clone can run every gate |

## How to view it

```bash
python3 devserver.py 3111 &
open http://127.0.0.1:3111/index.html
```

`index.html` is a grouped index of the live screens. Two more sit in the
directory without being linked from it, `criteria.html` and `confirm.html`,
which are retired and carry a banner saying what replaced them: an old link
lands somewhere honest instead of on a 404.

The floating "Builder notes" toggle on every page reveals the annotations:
which entity rule governs the screen, what must never be added to it, why it is
shaped the way it is, and the note saying that every name and number on these
screens is invented.

`GET /healthz` returns a build fingerprint, so "the server is dead" and "your
browser is showing you a cached page" stop being the same symptom.

## Running the gates

```bash
python3 devserver.py 3111 &
python3 verify_all.py http://127.0.0.1:3111
```

One command, one table, exit 0 only if every gate exits 0. Exit 3 means no
Chrome was found, which is reported as its own state and never folded into a
pass. No environment setup: the driver and the server are committed beside the
gates and use the standard library only.

The mutation suites are run separately, because they edit files and take
several minutes. They put each defect back, require the gate to FAIL, revert,
and require it to PASS, so a green gate is known to discriminate rather than
merely to run:

```bash
for m in verify_*mutation*.py; do python3 "$m" http://127.0.0.1:3111; done
```

Written as a glob rather than as a list of names. This paragraph named three of
the six suites for a fortnight, because a list of files in prose goes stale the
day a seventh is added and nothing ever tells you. `verify_all.py` reads them
off disk the same way for the same reason. The suites that take no url ignore
the argument.

## Rules that bind anyone building from this

The wireframe encodes decisions that are settled in `MISSION.md` and
`spec/entities.md`. The recurring ones, because every one of them is a thing a
well-meaning builder adds back:

- no score, rating, star, or blended trust number, anywhere
- no badge on unverifiable work; a portfolio claim has no verify affordance
- the three evidence tiers are never summed into one count
- no password field, no avatar upload, no UI implying write access to a
  buyer's repository
- a preview of built work is earned by evidence, never uploaded; a portfolio
  claim gets no preview and none may be added
- an absent price floor renders as nothing at all: no label, no placeholder,
  no zero, no "no minimum set"
- no price guidance anywhere: no suggested price, no recommended range, no
  cheapest-first sort or promotional placement
- no button that one party can press alone to close a two-party agreement
- merge rate is a fraction with its denominator, never a percentage
- nothing on any screen has the platform running, scoring or reviewing an
  agent's work; the attestation is facts only
- plain language on every primary path; exact terms live behind disclosures
- exactly one primary action per screen
- 44px tap targets on both axes, measured on a real touch profile
- zero em dashes in any file

`SITEMAP.md` section 9 lists six places where these screens need something
`spec/entities.md` does not yet define. Those are issue candidates, not
licence to invent fields.
