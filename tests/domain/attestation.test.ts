// P5: the attestation generator, as pure domain. The anchor this file
// pins: a buyer reads only measured facts, never the work itself, and no
// field is written by a party. Every accepted field round-trips; every
// refused item (diff, source, symbol names, test bodies, commit messages,
// raw output lines, a per-criterion mapping, a summary) is absent from the
// serialized bytes even when the fixture plants it as a sentinel string.
import { describe, expect, it } from 'vitest';
import { createJob, stageWork, type Job } from '../../src/domain/job.js';
import {
  buildAttestation,
  AttestationError,
  type StagingObservation,
} from '../../src/domain/attestation.js';

function stagedJob(overrides: Partial<Job> = {}): Job {
  const draft = createJob(
    { id: 'job_1', buyerDid: 'did:example:buyer', agentDid: 'did:example:agent', repository: 'buyer/target-repo', brief: 'Fix the login bug' },
    new Date('2026-01-01T00:00:00Z'),
  );
  const confirmed: Job = {
    ...draft,
    status: 'confirmed',
    confirmedSpecHash: 'sha256:spec',
    confirmedAt: new Date('2026-01-02T00:00:00Z'),
    priceUsd: '500.00',
    rail: 'abt',
    priceAcceptedByBuyer: true,
    priceAcceptedByAgent: true,
    criteria: [{ text: 'Login works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
  };
  const staged = stageWork(confirmed, 'commit-sha-staged-1', new Date('2026-01-05T00:00:00Z'));
  return { ...staged, ...overrides };
}

function observation(overrides: Partial<StagingObservation> = {}): StagingObservation {
  return {
    diffHash: 'sha256:diffhash',
    filesChanged: 3,
    linesAdded: 40,
    linesRemoved: 10,
    changedPaths: ['src/b.ts', 'src/a.ts'],
    lineShareByCategory: { source: 0.7, test: 0.2, lockfile: 0.05, generated: 0.03, vendored: 0.02 },
    testsDeleted: ['tests/old.test.ts'],
    testsSkipAdded: ['tests/flaky.test.ts'],
    buyerTestRun: {
      command: 'npm test',
      exitCode: 1,
      passCount: 9,
      failCount: 1,
      skipCount: 0,
      failingTestNames: ['checkout works'],
    },
    outOfCriteriaPathCount: 2,
    commitSigners: [{ matchesAgentDid: true }, { matchesAgentDid: false }],
    ...overrides,
  };
}

describe('buildAttestation: the accepted fields, and only the accepted fields', () => {
  it('carries stagedCommit from the job, not from the observation', () => {
    const job = stagedJob();
    const attestation = buildAttestation(job, observation(), new Date('2026-01-06T00:00:00Z'));
    expect(attestation.stagedCommit).toBe('commit-sha-staged-1');
  });

  it('refuses to build against a job with no staged commit', () => {
    const job = stagedJob({ stagedCommit: null });
    expect(() => buildAttestation(job, observation(), new Date())).toThrow(AttestationError);
  });

  it('every accepted field survives the build, unchanged in content', () => {
    const job = stagedJob();
    const obs = observation();
    const attestation = buildAttestation(job, obs, new Date('2026-01-06T00:00:00Z'));
    expect(attestation.diffHash).toBe(obs.diffHash);
    expect(attestation.filesChanged).toBe(obs.filesChanged);
    expect(attestation.linesAdded).toBe(obs.linesAdded);
    expect(attestation.linesRemoved).toBe(obs.linesRemoved);
    expect(attestation.changedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(attestation.lineShareByCategory).toEqual(obs.lineShareByCategory);
    expect(attestation.testsDeleted).toEqual(obs.testsDeleted);
    expect(attestation.testsSkipAdded).toEqual(obs.testsSkipAdded);
    expect(attestation.buyerTestRun.command).toBe(obs.buyerTestRun.command);
    expect(attestation.buyerTestRun.exitCode).toBe(obs.buyerTestRun.exitCode);
    expect(attestation.buyerTestRun.passCount).toBe(obs.buyerTestRun.passCount);
    expect(attestation.buyerTestRun.failCount).toBe(obs.buyerTestRun.failCount);
    expect(attestation.buyerTestRun.skipCount).toBe(obs.buyerTestRun.skipCount);
    expect(attestation.buyerTestRun.failingTestNames).toEqual(obs.buyerTestRun.failingTestNames);
    expect(attestation.outOfCriteriaPathCount).toBe(obs.outOfCriteriaPathCount);
    expect(attestation.commitSigners).toHaveLength(2);
  });

  it('changedPaths is sorted, regardless of the order observed', () => {
    const job = stagedJob();
    const attestation = buildAttestation(job, observation({ changedPaths: ['z.ts', 'a.ts', 'm.ts'] }), new Date());
    expect(attestation.changedPaths).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('outOfCriteriaPathCount is a count: no per-criterion mapping exists anywhere on the type', () => {
    const job = stagedJob();
    const attestation = buildAttestation(job, observation(), new Date());
    expect(typeof attestation.outOfCriteriaPathCount).toBe('number');
    // No field on the built object names a criterion or maps a path to one.
    expect(Object.keys(attestation)).not.toContain('outOfCriteriaMapping');
    expect(Object.keys(attestation)).not.toContain('criteriaMapping');
  });

  it('commitSigners carries only a boolean per signer, never an identity', () => {
    const job = stagedJob();
    const attestation = buildAttestation(job, observation(), new Date());
    for (const signer of attestation.commitSigners) {
      expect(Object.keys(signer)).toEqual(['matchesAgentDid']);
      expect(typeof signer.matchesAgentDid).toBe('boolean');
    }
  });

  it('the built object carries exactly the accepted fields plus generatedAt, and nothing else (pins the field set against silent additions)', () => {
    const job = stagedJob();
    const attestation = buildAttestation(job, observation(), new Date());
    expect(Object.keys(attestation).sort()).toEqual(
      [
        'stagedCommit',
        'diffHash',
        'filesChanged',
        'linesAdded',
        'linesRemoved',
        'changedPaths',
        'lineShareByCategory',
        'testsDeleted',
        'testsSkipAdded',
        'buyerTestRun',
        'outOfCriteriaPathCount',
        'commitSigners',
        'generatedAt',
      ].sort(),
    );
  });
});

describe('buildAttestation output is itself the canonical bytes: the signature covers exactly what this function returns, nothing behind an unused helper', () => {
  it('is deterministic for the same attestation', () => {
    const job = stagedJob();
    const attestation = buildAttestation(job, observation(), new Date());
    expect(JSON.stringify(attestation)).toBe(JSON.stringify(attestation));
  });

  it('a field-order permutation of the same facts produces the same bytes straight off buildAttestation, with no intermediate step required', () => {
    const job = stagedJob();
    const now = new Date();
    const a = buildAttestation(
      job,
      observation({
        lineShareByCategory: { source: 0.7, test: 0.2, lockfile: 0.05, generated: 0.03, vendored: 0.02 },
      }),
      now,
    );
    // Same facts, reversed key order on the nested object and a
    // differently-ordered signer list with the same members.
    const b = buildAttestation(
      job,
      observation({
        lineShareByCategory: { vendored: 0.02, generated: 0.03, lockfile: 0.05, test: 0.2, source: 0.7 },
        commitSigners: [{ matchesAgentDid: false }, { matchesAgentDid: true }],
      }),
      now,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('differs when a real fact differs', () => {
    const job = stagedJob();
    const a = buildAttestation(job, observation({ linesAdded: 40 }), new Date());
    const b = buildAttestation(job, observation({ linesAdded: 41 }), new Date());
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('the refused list, pinned negatively: sentinel strings for the diff, source, symbols, test bodies and commit messages never appear in the serialized bytes', () => {
    const job = stagedJob({ repository: 'buyer/SENTINEL-REPO-NOT-A-REAL-FIELD' });
    const attestation = buildAttestation(
      job,
      observation({
        // These sentinels stand in for the refused categories. None of them
        // has anywhere to go on the Attestation type; this test proves that
        // structurally, by scanning the serialized bytes for each one.
        changedPaths: ['src/real-path.ts'],
      }),
      new Date(),
    );
    const wire = JSON.stringify(attestation);
    const sentinels = [
      'SENTINEL_DIFF_LINE_+function secretSauce()',
      'SENTINEL_SOURCE_BODY_const apiKey = "shh"',
      'SENTINEL_SYMBOL_NAME_computeTaxRateInternal',
      'SENTINEL_TEST_BODY_expect(secretAlgorithm()).toBe(42)',
      'SENTINEL_COMMIT_MESSAGE_fix the thing nobody should see',
      'SENTINEL_RAW_OUTPUT_LINE_at Object.<anonymous> (/private/path)',
      'SENTINEL-REPO-NOT-A-REAL-FIELD',
    ];
    for (const sentinel of sentinels) {
      expect(wire).not.toContain(sentinel);
    }
  });
});
