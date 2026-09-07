// P5: the staging observation port (design record, 2026-09-01; this
// card's brief section 2). The facts an attestation carries come from
// measuring a staging repository -- diffing it, counting lines, checking
// commit signers against the agent DID. That measurement is an adapter
// concern, not a domain one, so it crosses this one narrow interface.
//
// B14b: the real observer landed in src/adapters/staging/github.ts, built
// entirely on the GitHub REST compare/commits endpoints (see that file's
// own header). It clones nothing, spawns nothing, and executes no line of
// the agent's code -- the anchor this card exists to enforce is
// "the platform reports what git plainly says about the staged commit
// and never executes a line of the agent's code" (Keaton, 2026-09-07: "I
// thought we were just an intermediary between the two parties").
// tests/architecture/no-execution.test.ts is the mechanical fence: it
// fails the build if this directory (or src/domain/attestation.ts) ever
// imports node:child_process, node:worker_threads, node:vm, or a package
// whose name looks like a sandbox/container runtime.
//
// AN UNWIRED BUILD MUST FAIL LOUDLY. The default here refuses with the
// same NotImplementedError every other unwired adapter in this codebase
// throws (src/adapters/not-implemented.ts), in the same shape: a caller
// hitting it during development learns exactly what to build next, and a
// production deployment that forgot to wire a real observer fails the
// stage route with a loud 503 rather than publishing an attestation full
// of zeroes -- a zeroed attestation is a lie a buyer would pay against,
// and silent-success-on-failure is the standing defect class this port
// exists to close off.
import { NotImplementedError } from '../not-implemented.js';
import type { StagingObservation } from '../../domain/attestation.js';

const CAPABILITY = 'staging';

export interface StagingObserveInput {
  // B14b: the staging repository the comparison runs against -- never
  // the buyer's own repository (invariant 1: reads only against the
  // staging repo). Both the memory observer and the real GitHub-backed
  // one accept these unconditionally; only the real one uses them.
  readonly owner: string;
  readonly repo: string;
  readonly stagedCommit: string;
  readonly baseCommit: string;
  readonly criteriaPaths: readonly string[];
  // B14b: the agent's own VERIFIED GitHub login (R-3/R-4, ENT-5), the
  // one identity commitSigners compares each commit's author against.
  // Passed per call, not baked into the observer at construction time,
  // because it is a fact about THIS job's agent, not about the observer
  // itself -- the same reasoning criteriaPaths above already follows.
  readonly verifiedAgentGithubLogin: string;
}

export interface StagingObserver {
  observe(input: StagingObserveInput): Promise<StagingObservation>;
}

// The default: refuses. See this file's header for why the real observer
// is out of scope, and src/adapters/not-implemented.ts for the shared
// error shape every other unwired adapter in this codebase already uses.
export function createUnwiredStagingObserver(): StagingObserver {
  return {
    observe(_input: StagingObserveInput): Promise<StagingObservation> {
      return Promise.reject(new NotImplementedError(CAPABILITY, 'observe'));
    },
  };
}

// A test drives this directly with fixed observations, keyed by the
// staged commit the caller asked about. Never fabricates an answer for a
// commit it was not seeded with: guessing an observation would be the
// same silent-success-on-failure defect the unwired default exists to
// avoid, only inside a test double instead of production code.
export function createMemoryStagingObserver(
  fixedObservations: ReadonlyMap<string, StagingObservation>,
): StagingObserver {
  return {
    async observe(input: StagingObserveInput): Promise<StagingObservation> {
      const observation = fixedObservations.get(input.stagedCommit);
      if (observation === undefined) {
        throw new Error(
          `no fixed observation was seeded for staged commit ${input.stagedCommit}`,
        );
      }
      return observation;
    },
  };
}
