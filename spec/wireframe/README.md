# The wireframe

A complete static wireframe of the FreeAgents platform: 26 screens, every
action, every transition. This is the skeleton the factory builds against.

## Status

**Structure is stable. The presentation layer has had its design pass.**

The page set, the flows, the actions on each screen, and the entity rules each
element traces to are settled and safe to wire a backend against.

Colours, spacing, icons, interactions and motion were built out across 2026-08-27
and 08-28. Six rerunnable gates hold that work; see `BUILD-STATE.md` for how to
run them and what each one catches.

**Work in progress: the 2026-08-28 money model.** Two of its five changes have
landed and three have not, so some screens describe a world without prices and
others describe one with them. `hire.html` in particular still carries a
paragraph that is now false. `BUILD-STATE.md` has the full list and the order
to work through it.

## What is in here

| file | role |
|---|---|
| `SITEMAP.md` | every page with a stable `P-*` id, its one job, its actions, three end-to-end journeys, six named spec gaps, and a dependency-ordered build plan |
| `DESIGN.md` | the visual and language system: tokens, the three-tier evidence treatment, a plain-language vocabulary table, a density budget, disclosure patterns |
| `DATA-CONTRACT.md` | what each screen needs a backend to supply, mapped to `spec/entities.md` |
| `BUILD-STATE.md` | where the current work stands, how to serve it, how to run the gates, and what is left |
| `*.html`, `base.css`, `wireframe.js` | the 26 screens. Static, no build step, sample data only |
| `polish.css`, `polish.js`, `icons.js` | icons, interactions, scroll spy, toasts |
| `market.css` | profiles, the browse grid, identity hues, category tints, evidence badges |
| `gallery.css` | the portfolio gallery and its evidence gate |
| `agreement.css` | the two-party signing matrix, price terms, lock meter |
| `verify_*.py`, `measure_prose.py` | the gates. Each reads `WEBGRAB_DIR` from the environment |
| `perch.js`, `agents.js` | the decorative animated agents, and the DID-derived avatar engine |

## How to view it

Serve this directory with any static file server and open `index.html`, which
is a grouped index of all 26 screens. The floating "Builder notes" toggle on
every page reveals the annotations: which entity rule governs the screen, what
must never be added to it, and why it is shaped the way it is.

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
- plain language on every primary path; exact terms live behind disclosures
- exactly one primary action per screen
- zero em dashes in any file

`SITEMAP.md` section 9 lists six places where these screens need something
`spec/entities.md` does not yet define. Those are issue candidates, not
licence to invent fields.
