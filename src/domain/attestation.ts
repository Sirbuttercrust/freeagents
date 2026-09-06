// P5: the attestation, as pure domain. The anchor (design record,
// 2026-09-01, and this card's brief): a buyer decides whether to pay from
// machine-produced facts and nothing else. The attestation never contains
// the work and never contains an opinion about the work. Every field here
// is measured by an adapter (src/adapters/staging), never written by a
// party, and this file never touches the diff, source, symbol names, test
// bodies, commit messages, raw output lines, a per-criterion mapping, or a
// summary of the approach -- the refused list, verbatim from the design
// record's synthesis row 5. buildAttestation is synchronous, pure, and
// takes its own `now`: no vendor import, no I/O, no clock of its own, so
// the same call with the same inputs produces the same bytes every time,
// which is what makes the platform signature over those bytes verifiable
// by a third party without calling this service (invariant 2).
//
// CANONICAL SERIALIZATION (this is the contract the signature covers):
//   - object keys in a fixed, explicit order (never Object.keys' insertion
//     order, which a caller could vary without changing any fact)
//   - changedPaths, testsDeleted and testsSkipAdded sorted lexicographically
//   - numbers written as JSON integers or the fixed-precision decimal a
//     line share is (never a locale-formatted string)
//   - no whitespace: JSON.stringify with no space argument
// A permutation of the same facts into a different field or array order
// must produce byte-identical output; see the mutation proof in this
// file's test for the pin.
import type { Job } from './job.js';

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationError';
  }
}

// The five categories the design record names, verbatim. A Record with
// exactly these keys, not a narrative: a share, not a description of what
// the lines do.
export interface LineShareByCategory {
  readonly source: number;
  readonly test: number;
  readonly lockfile: number;
  readonly generated: number;
  readonly vendored: number;
}

// The buyer's own test command, run against the staged commit. Nothing
// from that run beyond these six facts: specifically not one raw output
// line (the refused list forbids it; stack traces leak symbol names).
// Failing test NAMES are the one compromise the design record records:
// the buyer's own text, from the buyer's own test files.
export interface BuyerTestRun {
  readonly command: string;
  readonly exitCode: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly skipCount: number;
  readonly failingTestNames: readonly string[];
}

// One signer observed on the staged commit, checked against the agent
// DID. A boolean per signer, never the signer's own identity where it did
// not match -- the design record's exact wording ("not the signer's
// identity where it did not match").
export interface CommitSigner {
  readonly matchesAgentDid: boolean;
}

// What the staging observer measured (src/adapters/staging/types.ts owns
// the port this shape crosses). buildAttestation trusts this input
// completely: validating that a real measurement produced it honestly is
// the observer's job, not this pure function's.
export interface StagingObservation {
  readonly diffHash: string;
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly changedPaths: readonly string[];
  readonly lineShareByCategory: LineShareByCategory;
  readonly testsDeleted: readonly string[];
  readonly testsSkipAdded: readonly string[];
  readonly buyerTestRun: BuyerTestRun;
  readonly outOfCriteriaPathCount: number;
  readonly commitSigners: readonly CommitSigner[];
}

// The document itself: exactly the accepted field list, verbatim from the
// design record's synthesis row 5, and nothing else. `signature` is not
// part of this type: the domain builds the unsigned facts, and the
// credentials adapter signs the canonical serialization of them
// (src/adapters/credentials -- see its signAttestation method).
export interface Attestation {
  readonly stagedCommit: string;
  readonly diffHash: string;
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly changedPaths: readonly string[];
  readonly lineShareByCategory: LineShareByCategory;
  readonly testsDeleted: readonly string[];
  readonly testsSkipAdded: readonly string[];
  readonly buyerTestRun: BuyerTestRun;
  readonly outOfCriteriaPathCount: number;
  readonly commitSigners: readonly CommitSigner[];
  // The instant the platform built the document. Not part of the accepted
  // field list's own enumeration, but every signed document in this
  // service carries when it was produced (credentials.ts's validFrom
  // keeps the same stance); the buyer sees a countable fact, not a claim.
  readonly generatedAt: string;
}

// stagedCommit is read from the JOB, never from the observation: the
// brief's own instruction ("from the job, not from a party") is honoured
// by construction, since observation carries no stagedCommit field to
// even be tempted by.
export function buildAttestation(job: Job, observed: StagingObservation, now: Date): Attestation {
  if (job.stagedCommit === null) {
    throw new AttestationError(
      `cannot build an attestation for job ${job.id}: it has no staged commit`,
    );
  }
  return {
    stagedCommit: job.stagedCommit,
    diffHash: observed.diffHash,
    filesChanged: observed.filesChanged,
    linesAdded: observed.linesAdded,
    linesRemoved: observed.linesRemoved,
    changedPaths: [...observed.changedPaths].sort(),
    lineShareByCategory: { ...observed.lineShareByCategory },
    testsDeleted: [...observed.testsDeleted].sort(),
    testsSkipAdded: [...observed.testsSkipAdded].sort(),
    buyerTestRun: {
      command: observed.buyerTestRun.command,
      exitCode: observed.buyerTestRun.exitCode,
      passCount: observed.buyerTestRun.passCount,
      failCount: observed.buyerTestRun.failCount,
      skipCount: observed.buyerTestRun.skipCount,
      failingTestNames: [...observed.buyerTestRun.failingTestNames].sort(),
    },
    outOfCriteriaPathCount: observed.outOfCriteriaPathCount,
    commitSigners: observed.commitSigners.map((signer) => ({ matchesAgentDid: signer.matchesAgentDid })),
    generatedAt: now.toISOString(),
  };
}

// The canonical serialization the platform signature covers (see this
// file's header comment). Every key is written in a fixed order chosen
// here, never derived from the object's own enumeration order, so a
// caller that assembled the same facts through a different code path
// still signs and verifies against the same bytes.
export function serializeAttestation(attestation: Attestation): string {
  const canonical = {
    stagedCommit: attestation.stagedCommit,
    diffHash: attestation.diffHash,
    filesChanged: attestation.filesChanged,
    linesAdded: attestation.linesAdded,
    linesRemoved: attestation.linesRemoved,
    changedPaths: [...attestation.changedPaths].sort(),
    lineShareByCategory: {
      source: attestation.lineShareByCategory.source,
      test: attestation.lineShareByCategory.test,
      lockfile: attestation.lineShareByCategory.lockfile,
      generated: attestation.lineShareByCategory.generated,
      vendored: attestation.lineShareByCategory.vendored,
    },
    testsDeleted: [...attestation.testsDeleted].sort(),
    testsSkipAdded: [...attestation.testsSkipAdded].sort(),
    buyerTestRun: {
      command: attestation.buyerTestRun.command,
      exitCode: attestation.buyerTestRun.exitCode,
      passCount: attestation.buyerTestRun.passCount,
      failCount: attestation.buyerTestRun.failCount,
      skipCount: attestation.buyerTestRun.skipCount,
      failingTestNames: [...attestation.buyerTestRun.failingTestNames].sort(),
    },
    outOfCriteriaPathCount: attestation.outOfCriteriaPathCount,
    // Signers carry no identifying field to sort by; the count and the
    // multiset of booleans are the whole fact, so a stable sort on the
    // boolean value (false before true) removes the only remaining
    // ordering freedom a caller could vary without changing any fact.
    commitSigners: [...attestation.commitSigners]
      .map((signer) => ({ matchesAgentDid: signer.matchesAgentDid }))
      .sort((a, b) => Number(a.matchesAgentDid) - Number(b.matchesAgentDid)),
    generatedAt: attestation.generatedAt,
  };
  return JSON.stringify(canonical);
}
