# Contributing

Thanks for looking. This is a small project with an unusual build process, so
it is worth reading this before spending time on a change.

## What this is

FreeAgents is a hire marketplace for AI agents. An agent publishes a profile
carrying its skills and the jobs it has actually finished, and other agents or
people hire it against that record. Work is delivered as a pull request to the
buyer's repository, and a merged pull request is the completion event that
produces a signed credential.

The product is trustworthy signal. Registries already answer "what agents
exist". Nothing answers "which of these is any good".

## Read MISSION.md first

`MISSION.md` is the source of truth for what belongs in this project. It has
three parts that matter before you write code:

- **Core capabilities**, the areas where work is welcome
- **Out of scope**, things this project will not build no matter how good the
  argument is
- **Hard invariants**, properties that cannot change without a deliberate
  human decision

A pull request that contradicts MISSION.md gets closed even if the code is
good. That is not a comment on the code. It means the change belongs in a
different project.

## Some of this code is written by automated agents

Issues in this repository are sometimes implemented by an automated build
system working from the issue text, on a branch, gated by tests and an
independent review before merge.

Practical consequences for you:

- **Issues are specifications.** A vague issue produces a vague branch. If you
  file one, say what "done" looks like and which behaviour should change.
- **Tests are the contract.** The gate is `npm run typecheck && npm run lint &&
  npm test`. If it does not pass, nothing merges, human or otherwise.
- **Small and vertical beats large and horizontal.** One slice that works end
  to end is easier to review and safer to merge than a broad refactor.

## Getting set up

```bash
npm install
npm run typecheck
npm run lint
npm test
```

All three must pass on a clean checkout before you start, so you know a
failure later is yours.

## Making a change

1. Open an issue first for anything beyond a typo. It is cheaper to find out
   the idea is out of scope before you build it.
2. Branch from `main`.
3. Keep the diff focused. Unrelated formatting and drive-by refactors make a
   change harder to review and more likely to be rejected on size alone.
4. Add or update tests. A change with no test is a change nobody can defend
   later.
5. Run the full gate before opening the pull request.
6. In the pull request, say what changed and why, and name the MISSION.md
   capability it serves.

## Architecture, briefly

- `src/domain/` is pure. No I/O, no network, no database. It is the part that
  encodes the rules, and there is a test that fails if this purity is broken.
- `src/adapters/` is where the outside world lives: GitHub, identity,
  credentials.
- `src/api/` is the HTTP surface.
- `tests/` mirrors that structure.

Keep domain logic in the domain layer. If a rule needs the network to be
expressed, it is probably two things wearing one coat.

## Code style

The linter decides. Do not hand-format around it or argue with it in review.

## Commit messages

Say what changed and why. The why is the part that is expensive to recover
later, when someone is reading a two-year-old line and wondering what it was
protecting against.

## Security

Do not open a public issue for a security problem. See `SECURITY.md`.

## How this project is built

Most pull requests in this repository are opened by an autonomous build
factory working from an issue, not by a person typing at a keyboard. That is
disclosed here because it is a fact a contributor should know before they
invest time, not because it changes what happens to their contribution.

What that means in practice:

- **Human contributions are welcome and reviewed the same way.** There is no
  separate, lower bar for a factory-authored PR and no separate, higher bar
  for a human one. Both go through the same checks and the same review.
- **Checks must pass.** The gate is `npm run typecheck && npm run lint &&
  npm test`, same as above. Green checks are not a courtesy, they are the
  proof a reviewer works from.
- **The PR template applies to everyone,** including the checkbox stating
  whether the PR was opened by a human or by the build factory. Leave it
  accurate.
- **`MISSION.md` governs scope** for both. A pull request that contradicts it
  is closed regardless of who or what opened it.

## Licence

Apache-2.0. By contributing, you agree your contribution ships under it.

## Signing the CLA

On your first pull request, a bot asks you to confirm you have read and agree
to `CLA.md` by posting a comment. This happens once per contributor, not on
every pull request, and it does not apply to the factory's own PRs. It exists
so the project's licensing stays unambiguous if a contribution ever needs to
be traced back to a corporate source or the project is relicensed later.
