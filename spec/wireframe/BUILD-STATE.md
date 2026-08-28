# FreeAgents wireframe: where the work is, and what is left

Written 2026-08-28 for whoever picks this up next, including a later version of
me with no memory of it. Everything here is checkable with a command.

## The one thing to know first

**Branch `task/freeagents-money-model`, and it stacks on unmerged work.**

```
git fetch origin
git checkout task/freeagents-money-model
```

It carries seven commits that are not on `main`. Five are the 08-27 polish
pass, two are the 08-28 money model. `main` is NOT a valid base for this work:
it has no `polish.css`, no `polish.js`, and none of the six verify gates, so
the verify commands below would not exist in the tree. `main`'s one extra
commit `7ccebc2` touches zero wireframe files, so there is no conflict either
direction.

Proof is judging a stacked changeset. That is deliberate and it is the reason
this note exists.

## Serving it

Any static file server works. There is no build step.

```
cd spec/wireframe && python3 -m http.server 3110 --bind 0.0.0.0
```

Bind `0.0.0.0`, never `127.0.0.1`. A loopback bind answers curl on the serving
machine with a 200 and is invisible from every other device, which is the most
misleading failure available.

For anything longer than one session, put it under a service manager rather
than a shell. On macOS that is a launchd agent with `KeepAlive` and
`RunAtLoad`; systemd user units do the same job elsewhere.

The server was lost five times in two days before this, always the same way: a
shell-child process dies with its session, and the dying process can hold the
port long enough that the next launch fails with `Errno 48` while a stale tree
keeps answering. A restart then looks successful and serves nothing.

## Running the gates

All six read `WEBGRAB_DIR` from the environment. They have no hardcoded home
paths, because this repository is public and `publish_gate.sh` blocks on them.

```
cd spec/wireframe
WEBGRAB_DIR=<dir holding webgrab.py> python3 verify_polish.py          # 26 screens
WEBGRAB_DIR=<dir holding webgrab.py> python3 verify_reduced_motion.py
WEBGRAB_DIR=<dir holding webgrab.py> python3 verify_agents_below.py
WEBGRAB_DIR=<dir holding webgrab.py> python3 verify_profile_header.py
WEBGRAB_DIR=<dir holding webgrab.py> python3 verify_blast_preview.py
WEBGRAB_DIR=<dir holding webgrab.py> python3 measure_prose.py          # reports, does not gate
cd ../.. && bash factory/publish_gate.sh .
```

Last run, all green: polish PASS (26 screens, 200 icons), reduced motion PASS,
agents below PASS, profile header PASS, blast preview PASS, publish gate CLEAR
on 18 checks, contrast 0 genuine failures.

`verify_polish.py` is the one that catches the most. It checks every screen at
320px under a real touch profile for console errors, unpainted icons, inert
controls, horizontal overflow, and tap targets under 44px.

## What each layer is for

Load order matters. Every file only adds class names, so nothing below is
overridden and `base.css` stays the readable statement of the system.

| file | what it owns |
|---|---|
| `base.css` | the foundation: tokens, `.pane`, reveals, focus rings, the four standing rules |
| `polish.css` / `polish.js` | icons, interactions, scroll spy, toasts, the shared `.factlist` and `.callout-sm` |
| `market.css` | profiles, the browse grid, identity hues, category tints, the two badges |
| `gallery.css` | the portfolio gallery and its tier gate |
| `agreement.css` | the two-party signing matrix, price rows, lock meter, floor, redo |
| `icons.js` | 44 glyphs, no dependency and no external request |
| `agents.js` | the DID-derived avatar engine |

## The rules that shaped these screens

Each of these is a thing a well-meaning builder adds back, so they are worth
reading before touching anything.

**The accent means one thing.** `DESIGN.md` 2.2 reserves `--accent` for "we
watched this happen": a verified hire, its count, its pull request, the
credential verify affordance, the focus ring. Nothing else may take it. Every
hover, tab, spy marker, stepper pip and toast in this work is a neutral. The
signing layer uses NO accent at all, because a signature is a fact about what
two parties promised, not about work anybody witnessed.

**A preview is earned by evidence, never uploaded.** Verified hire and verified
prior work get a preview; a portfolio claim gets nothing and none may be added.
`MISSION` bars user-uploaded imagery permanently, and `ENT-12.4` bars fetching
an operator-supplied URL at all. Self-built work counts as prior work under
`ENT-11`, which turns on "a repository it can prove it controls" rather than on
who commissioned it.

**Absence is displayed honestly.** An agent with no price floor emits NO floor
element: no label, no placeholder, no dash, no "no minimum set". An empty
labelled row looks like a field that failed to load, and a "no minimum" label
reads as "offer anything", which is downward price guidance from the venue that
takes a cut. The 08-28 ruling bans that outright.

**No button one party can press alone.** The agreement locks when the last
signature lands. `criteria.html` has no primary button at all, deliberately: a
disabled one in that spot still teaches a person to hunt for the control that
finishes the deal.

**Density is a defect.** The operator has raised it twice. Convert prose into
components rather than shortening it, and measure with `measure_prose.py`
rather than eyeballing. The agreement page went 1,948 to 1,162 visible chars by
becoming a matrix, and the word "axiom-ui" went from 17 occurrences to 1.

## What is done on the money model card

Source of truth: the 2026-08-28 sections of the project map, which is where
the money model decisions are recorded. The operator holds it.

| change | state |
|---|---|
| 1. two-party signing loop | done on `criteria.html`, commits `71ad196` and `baaa220` |
| 2. price exists, agent quotes it | done on `criteria.html` as terms 06 and 07 |
| 3. optional operator price floor | NOT STARTED |
| 4. platform never touches funds | NOT STARTED |
| 5. one redo per hire | NOT STARTED |

Two rulings from the operator, already applied where relevant:

- Step 3 of the hire rail is **"Agreement"**, not "Confirm". Confirm names a
  button one party presses. The rail is copied byte for byte across
  `hire.html`, `criteria.html` and `confirm.html`, so it changes in all three
  or none. Only `criteria.html` is done; the other two still say Confirm.
- An absent floor renders as **nothing at all**, on both profiles and cards.

## What is left, in order

1. `confirm.html` stops being a gate and becomes the locked agreement plus its
   digest. "Confirm and hire" goes. The Payment terms pane currently reads "not
   set in this version" four times and needs real terms, plus one plain
   sentence that money moves between the two parties and we never hold it.
2. `hire.html` carries a paragraph that is now FALSE: "No price field, no
   escrow, no payment step. v1 moves no money". Replace with the accurate
   absences, which are that we never hold funds and never suggest a price.
   Rail label to Agreement.
3. `job.html` gains the agreed price and window as recorded facts, the redo
   allowance shown used or unused, and a digest covering the whole deal rather
   than criteria alone.
4. The floor on four pages. `listagent.html` and `agentsettings.html` set it,
   with the circuit-breaker reason stated in one line: the operator's own
   autonomous agent cannot be argued below it while they sleep.
   `agent.html` and `browse.html` display it when set and emit nothing when
   not. No price sort, no cheapest-first, no promotional placement.
   Note: the brief guessed `myagents.html` for editing, but that page is a
   list and `agentsettings.html` is the per-agent edit screen.
5. `myjobs.html` and `incoming.html` need half-signed to read at a glance. The
   useful distinction is not "half signed", it is whose turn it is. The `.turn`
   component in `agreement.css` is already written for this and unused.
6. `how.html` has no money section at all, which is now a hole in the page that
   explains the platform. It gains one, and "we never suggest a price" joins
   the existing entries under what we deliberately do not do.
7. `DATA-CONTRACT.md` and `DESIGN.md` move in the SAME branch. Section 8 of the
   contract gains the price guidance ban and the card fields gain the floor;
   the design vocabulary table gains signature, floor, redo and digest.
   Changing screens without these two is how the wireframe drifts from its own
   contract.

## Open questions that are not mine to answer

- `spec/PORTFOLIO-QUESTIONS.md`, five questions. The blocking one is where a
  preview image comes from. Rendering it ourselves needs a narrow written
  carve-out to `ENT-12.4` restricted to already-verified repositories.
- A floor that fails to LOAD is not the same as an absent floor. Nothing in the
  map covers that error state, so nothing is drawn for it.
- What a signature covers: this draws one per line over that line's own text,
  which is what makes a per-line edit clear only that line. One signature over
  the whole document is simpler to verify and loses that. The map specifies per
  line.

## Standing rules for this repo

Public repository. No absolute paths, machine names, usernames, IP addresses or
personal names in any committed file, including commit messages.
`bash factory/publish_gate.sh .` before every push; it fails closed and scans
git history, not only the working tree.

Zero em dashes anywhere, including code comments and commit messages.

Never declare this done. Proof is the sole terminator, and merges to master
happen after a PASS through the SHA-pinned gate.
