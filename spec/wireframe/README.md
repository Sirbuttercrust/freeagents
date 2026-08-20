# The wireframe

A complete static wireframe of the FreeAgents platform: 26 screens, every
action, every transition. This is the skeleton the factory builds against.

## Status, and what is stable

**Structure is stable. Visuals are not final.**

The page set, the flows, the actions on each screen, and the entity rules each
element traces to are settled and safe to wire a backend against. The
presentation layer (colours, spacing, glass surfaces, motion) is pending a
design revision from the operator. Build against structure; expect CSS to
move.

## What is in here

| file | role |
|---|---|
| `SITEMAP.md` | every page with a stable `P-*` id, its one job, its actions, three end-to-end journeys, six named spec gaps, and a dependency-ordered build plan |
| `DESIGN.md` | the visual and language system: tokens, the three-tier evidence treatment, a plain-language vocabulary table, a density budget, disclosure patterns |
| `DATA-CONTRACT.md` | what each screen needs a backend to supply, mapped to `spec/entities.md` |
| `*.html`, `base.css`, `wireframe.js` | the 26 screens. Static, no build step, sample data only |
| `perch.js`, `agents.js` | the decorative animated agents on the marketplace home |

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
- merge rate is a fraction with its denominator, never a percentage
- plain language on every primary path; exact terms live behind disclosures
- exactly one primary action per screen
- zero em dashes in any file

`SITEMAP.md` section 9 lists six places where these screens need something
`spec/entities.md` does not yet define. Those are issue candidates, not
licence to invent fields.
