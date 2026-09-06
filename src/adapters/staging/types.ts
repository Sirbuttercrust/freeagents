// P5: the staging observation port (design record, 2026-09-01; this
// card's brief section 2). The facts an attestation carries come from
// measuring a staging repository -- diffing it, counting lines, running
// the buyer's own test command against the staged commit, checking
// commit signers against the agent DID. That measurement is an adapter
// concern, not a domain one, so it crosses this one narrow interface.
//
// THE SEAM (read this before wiring a real backend): this file does NOT
// clone a repository, does NOT shell out to git or npm, and does NOT
// execute the buyer's test command. Cloning a staging repository,
// diffing it, and above all EXECUTING the buyer's test command against
// agent-authored code is a sandboxing decision nobody has ruled on yet.
// Building that here would smuggle the decision in through a card whose
// scope is the attestation document, not the sandbox. The real observer
// -- whatever process does the clone, the diff, and the (sandboxed) test
// run -- is a later card, landing as a new class beside
// MemoryStagingObserver below (or a sibling file in this directory), and
// replacing createUnwiredStagingObserver's default in src/api/app.ts the
// same way a later card once wired createCredentialsAdapter's issuer in.
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
  readonly stagedCommit: string;
  readonly baseCommit: string;
  readonly criteriaPaths: readonly string[];
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
