# What the reconcile changed, and why

Branch `task/d1-wireframe-reconcile`. Written 2026-09-13 against the tree at
that point, and appended to by the two cards that work on top of this merge.

The reconcile took two wireframes with a common ancestor and produced one set on
the polished visual system: the late-August polished pass (identity colour,
generated swarm avatars, social-style profile headers, the portfolio gallery,
the agreement as a signature matrix, the dashboard pipeline) as the visual
source, and `main`'s September payment flow folded onto it.

This file exists because **a merge that keeps every file can still lose an
element**, and nobody notices until a reader misses a sentence. The first
version of the handoff claimed nothing was lost and backed it by comparing file
lists. That claim was true and it was the wrong claim: both parents' files all
survive, and elements inside them did not.

## How the list below was produced

`reconcile_inventory.py` reads the markup of every screen on both parents and on
the result, and diffs the vocabulary each screen uses: class names, ids, the
identity hooks the polished system hangs treatment on (`data-avatar`,
`data-ico`, `aria-label`), and the stylesheets and scripts each screen loads.

```
python3 reconcile_inventory.py                 # both parents against HEAD
python3 reconcile_inventory.py --ref HEAD --result 14d7a64    # positive control
```

It is an inventory, not a verdict, and that is deliberate. A class absent from
the result can be a rename, a fold into a shared component, or a real deletion,
and no script can tell those apart. The reason is the part a person supplies,
which is what the rest of this file is.

Two things about the instrument are worth knowing before trusting its output,
because both printed a clean green over a broken comparison:

- `git ls-tree` prints paths **relative to the CWD**. Run from the wireframe
  directory it returned `agent.html` where the rest of the script expected
  `spec/wireframe/agent.html`, so every `git show` failed, every screen compared
  as empty against empty, and the sweep reported "none" for all 33 screens on a
  total visual system swap. Fixed with `--full-name` plus a `:/`-rooted
  pathspec.
- `read()` swallowed the resulting error and returned `""`. A failed read and a
  screen with no markup are indistinguishable downstream, which is what made the
  bug above silent instead of loud. It exits 2 now.

The positive control is the check that matters: pointed at `HEAD` as the parent
and the raw pre-review reconcile as the result, it must report the things rounds
1 to 8 added. It reports `.av`, `[data-avatar]`, `<swarm.js>` and `#bannerlbl`.
A sweep that finds nothing has not been shown to discriminate.

## Nothing left the product silently

Every name below is absent from the screen it was on. Each line says where it
went and why. The three groups are different kinds of change and only the third
would be a defect.

### 1. Renamed, same component, same behaviour

Every pair in this table is checked rather than asserted. `check_renames.py`
requires that the old name is gone from the whole set and the new one is present
on each screen that carried the old one:

```
python3 check_renames.py     # exit 1 names any pair that does not hold
```

That check earned its place immediately. The first version of this table was
written by reading the diff, and **six of fifteen pairs were wrong**: it claimed
flat names (`.avatar -> .av`, `.ident -> .who`, `.agent -> .n`) where the
polished set actually uses NAMESPACED components, `acard-*` for a marketplace
card and `p*` for a profile header. Each wrong row named a class that is not on
that screen at all, and all six read as plausible.

| was | is now | why |
|---|---|---|
| `.edit` | `.act` | the polished matrix's control name. `verify_blast_preview.py` drives a real pointer onto `.act` and asserts the signature marks it clears, so the rename is gated rather than asserted |
| `.avatar` | `.acard-av` | the marketplace card became the `acard` component in `market.css` |
| `.agent`, `.name` | `.acard-name` | two names for the card's agent name became one |
| `.desc` | `.acard-desc` | card description. Text confirmed rendering: the three agent descriptions on `browse.html` appear verbatim |
| `.proof` | `.acard-proof` | the evidence line on the card |
| `.pavatar`, `.oav` | `.pav` | the profile header's generated identity avatar, painted from the DID by `FASwarm.avatar`. An avatar is an identity fingerprint, so no screen chooses one |
| `.ident` | `.pname` | the profile identity line |
| `.ohead` | `.phead` | the social-style profile header, which is the polished pass's own component |
| `.thead` | `.terms-head` | the agreement table head became the signature matrix's |
| `.trow` | `.term-line` | a term row |
| `.m-you`, `.m-them` | `.h-you`, `.h-them` | the two signature columns |
| `.mark-on`, `.mark-off` | `.sig.is-signed`, `.sig.is-cleared` | signature state moved from two classes to one element with a state class, which is what let the blast preview read it |

### 2. Folded into a shared component or promoted into the chrome

| was | where it went |
|---|---|
| `.tier-claim`, `.tier-hire`, `.tier-prior`, `.tierrow` | the three evidence tiers are a table on `how.html` now, columns instead of repeated labelled rows. All three tier names still render: `Verified hire`, `Verified prior work`, `Portfolio claim` |
| `.nope` | the three refusals are cards on `how.html`. All three still render: no write access, no judgement on the work, no score ever |
| `.th-line` | the matrix draws the column rule in `agreement.css` rather than as an element |
| `.hire`, `.act` (on `agent.html`) | the polished profile header's action row |
| `.summary`, `.ds`, `.right`, `.rows`, `.skills`, `.tier`, `.dot`, `.f` | absorbed by `market.css` card and `polish.css` pane recipes. `.dot` in particular was a flat status disc on six screens and is now the generated avatar or an `[data-ico]` glyph |
| `.flow` (class on `how.html`) | the step rail |
| `.halfnote`, `.why`, `.outstanding` | see the open question below. The `.why` fixed-term explanations and the lock countdown both still render on `agreement.html`; the per-line edit sentence does not |
| `.accessline` | see the open question below |
| `#agtech`, `#bannerlbl` | `#agtech`'s three technical facts are back on `agreement.html` and gated by `verify_kept.py` (they were genuinely lost once and restored in round 2). `#bannerlbl` was a `<label>` naming nothing over five swatch buttons, replaced by `role="group"` plus `aria-labelledby`, which is the fix for a label that announces a field that does not exist |

### 3. Deliberately retired

- **`confirm.html` keeps its file and is retired as a screen.** The agreement
  locks when the deposit settles. There is no button, because a lone control one
  party presses contradicts the two-signature model it would exist to enforce.
- **`flow.js` is dead code and no screen loads it.** `polish.js` absorbed its
  entire job (`[data-opens]`, `[data-closes]`, backdrop click, the `showModal`
  feature test). Verified by real input rather than by reading source: clicking
  all three triggers on `staged.html` at their own coordinates opens each dialog
  modally (`open=true`, `:modal` true, 520x529 and 520x494 boxes) with zero page
  errors. Kept on disk rather than deleted because the payment restyle card is
  told to fold `flow.css`, and deleting a file that card is about to read is how
  a reason gets lost. **That card should delete it and say so here.**
- **`pipeline.css` was `flow.css` on the polished branch.** Two different files
  held that one name and they share no selector: one draws the dashboard job
  track, the other the hire and payment flow. Renaming the dashboard one is why
  both survive. Do not merge them.
- **`agreement.css` replaced `criteria.html`'s local agreement styling.** The
  30 selectors that left `criteria.html` (`.lockbar`, `.sig*`, `.term-*`,
  `.rule-*` and the rest) are the polished matrix's, now shared rather than
  page-local.

### 4. Dead rules left in `flow.css`, for the card that folds it

`flow.css` is loaded by six payment screens and 60 of its 70 class selectors
still govern markup. Ten do not, and they are exactly the agreement-table
classes the polished matrix replaced:

```
edit, m-them, m-you, mark-off, mark-on, outstanding, th-line, thead, trow, why
```

```
python3 flowcss_deadrules.py     # regenerates the live/dead split
```

A rule keyed on a class no markup uses is dead and looks alive. These are safe
to drop when `flow.css` is folded, and dropping them is not a design change.

## Open questions, not decided here

Two sentences from `main` render on no screen in the set. Both are a judgement
about what a reader needs, not a visual-system question, so neither is settled
silently:

1. **The per-line edit sentence.** `main`'s agreement carried "Editing a line
   clears the signatures on that line only. The other six stay signed. Hover an
   edit control to see exactly which marks it clears." The BEHAVIOUR is intact
   and gated (`verify_blast_preview.py` proves the hover marks the right
   signatures, and the matrix shows `you edited this, both signatures cleared`
   on row 04), but the sentence explaining it to a first-time reader is gone.
   The matrix demonstrates the rule where the prose stated it, which is usually
   the better design. Flagging it because "the reader discovers it by hovering"
   is a choice someone should make on purpose.

2. **`job.html`'s access line.** "FreeAgents never had access to
   northline/design-tokens. axiom-ui forked the repository and opened this pull
   request from its own GitHub account." The equivalent refusals render on
   `how.html` ("It never gets write access to your repository", "No write access
   to your code"), so the FACT survives in the set. Whether it also needs to sit
   on the job screen, where a buyer is looking at a specific pull request, is a
   content call. It is the kind of fact a person is misled by the absence of, so
   if it belongs anywhere it belongs there.

Neither blocks a rebuild. Both are recorded rather than answered because this
card's job was the visual system, and inventing an answer to a content question
is worse than naming it.

## What this file does not cover

The eight payment screens' restyle and the three-document fold-in are separate
cards working on this branch. Each appends here rather than rewriting: the
reason a thing changed is only cheap to record at the moment it changes.
