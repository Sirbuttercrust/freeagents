# Proposed MISSION.md addition: the intermediary rule

Written by anvil for Temper to carry to Keaton. MISSION.md is a governance
file; this card does not edit it directly. The paragraph below is meant to
land under "Settlement, and the platform's cut" (MISSION.md, the section
already describing the attestation), stated as its own line the same way
the section's existing settlement rulings are stated.

## Source

Keaton, 2026-09-07, on why the attestation dropped the buyer's test run:

> "Like is the purpose to review their code? I thought we were just a
> intermediary between the two parties"
> "Ensure work is not drifting out of scope"

## The paragraph

**The platform is an intermediary between the two parties, never an
inspector of the work.** The attestation the buyer reads before paying the
balance carries only facts git and GitHub already state about the staged
commit: a diff stat, a changed path, a signature check. The platform runs
no line of the agent's code, ever, including the buyer's own test command
against the staged commit. Running that command would make the platform an
inspector rendering a verdict on the work, and the whole model this
document describes rests on the platform never doing that. A future
proposal to run any agent-authored code, sandboxed or not, is the same
class of decision "Executing work" already rules out above and needs the
same human commit any hard invariant needs, not a card whose scope is the
attestation document.
