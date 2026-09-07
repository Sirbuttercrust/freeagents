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
// B14b: the buyer's own test command is GONE, permanently. Running it
// against the staged commit means the platform executes untrusted
// agent-authored code and reports a verdict on it -- an inspector, not
// the intermediary the platform is (Keaton, 2026-09-07: "I thought we
// were just an intermediary between the two parties"). Every field that
// survives below is something git or GitHub plainly says about the
// staged commit: a diff stat, a path, a signature check. `testsDeleted`
// and `testsSkipAdded` stay for exactly that reason -- they are static
// facts about the diff text (a test file removed, a `.skip(` line
// added), never the result of running anything.
//
// CANONICAL SERIALIZATION (this is the contract the signature covers, and
// it is produced by buildAttestation itself, not by a separate step
// downstream of it -- the credentials adapter signs this object verbatim,
// so any normalization has to live here or the signed document does not
// actually carry it):
//   - object keys in a fixed, explicit order (never Object.keys' insertion
//     order, which a caller could vary without changing any fact)
//   - changedPaths, testsDeleted and testsSkipAdded sorted lexicographically
//   - commitSigners sorted by matchesAgentDid (false before true): signers
//     carry no other field to sort by, so this is the only ordering
//     freedom a caller could vary without changing any fact
//   - lineShareByCategory's five keys always written in the same order
//   - numbers written as JSON integers or the fixed-precision decimal a
//     line share is (never a locale-formatted string)
// A permutation of the same facts into a different field or array order
// must produce byte-identical JSON.stringify output off the object this
// function returns; see the mutation proof in this file's test for the
// pin.
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
//
// Every field below is written in the same explicit key order every
// call, and the array fields are sorted, so this object's own
// JSON.stringify output IS the canonical serialization the platform
// signature covers (this file's header). There is no separate
// serialization step downstream: normalizing here, once, is what keeps
// the signed document (src/adapters/credentials/credentials.ts embeds
// this object verbatim under credentialSubject.attestation) actually
// order-invariant, instead of only a helper nothing calls being
// order-invariant.
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
    lineShareByCategory: {
      source: observed.lineShareByCategory.source,
      test: observed.lineShareByCategory.test,
      lockfile: observed.lineShareByCategory.lockfile,
      generated: observed.lineShareByCategory.generated,
      vendored: observed.lineShareByCategory.vendored,
    },
    testsDeleted: [...observed.testsDeleted].sort(),
    testsSkipAdded: [...observed.testsSkipAdded].sort(),
    outOfCriteriaPathCount: observed.outOfCriteriaPathCount,
    // Signers carry no identifying field to sort by; the count and the
    // multiset of booleans are the whole fact, so a stable sort on the
    // boolean value (false before true) removes the only remaining
    // ordering freedom a caller could vary without changing any fact.
    commitSigners: [...observed.commitSigners]
      .map((signer) => ({ matchesAgentDid: signer.matchesAgentDid }))
      .sort((a, b) => Number(a.matchesAgentDid) - Number(b.matchesAgentDid)),
    generatedAt: now.toISOString(),
  };
}
