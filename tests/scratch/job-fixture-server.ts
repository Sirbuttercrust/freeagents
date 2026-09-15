// Boots the REAL app with the SAME fixtures tests/web/job-wireframe.test.ts
// builds, on a fixed port, and leaves it running.
//
// Why this exists: the three real-browser layout tests in that file cannot
// run on this machine. Every freshly-launched Chrome here hangs forever on
// any http navigation (proven: data: URLs load, http never reaches the
// server, and the same three tests fail identically on unmodified main).
// A Chrome that was already running does work, so the measurements are
// taken by driving that one against this server instead. Same app, same
// fixtures, same URLs the tests use.
//
// Not committed to the repo: this is session scaffolding for a broken
// environment, and the assertions it substitutes for already live in
// tests/web/job-wireframe.test.ts, which is the thing that must pass on a
// machine with a working browser.
import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import { createJob, type Job } from '../../src/domain/job.js';
import type { Delegation } from '../../src/domain/agent.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';

const PORT = Number(process.env.PORT ?? 4599);
const BUYER_DID = 'did:example:w4-buyer';
const AGENT_DID = 'did:abt:zW4Agent';
const OPERATOR_DID = 'did:abt:zNKtD5hwiSDiwLrD6tAQRNTN1ZiDBBpaKrb';
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

function delegationFixture(did: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:w4-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: did },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zw4-fixture-not-verified-here',
    },
  };
}

function jobFixture(overrides: Partial<Job> & { id: string; agentDid: string }): Job {
  const base = createJob(
    {
      id: overrides.id,
      buyerDid: BUYER_DID,
      agentDid: overrides.agentDid,
      repository: 'buyer/w4-repo',
      brief: 'Fix the checkout flow',
    },
    new Date('2026-08-01T00:00:00Z'),
  );
  return { ...base, ...overrides };
}

function credentialDoc(jobId: string, mergeCommit: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${jobId}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:brief',
        repository: 'buyer/w4-repo',
        pullRequest: 'https://github.com/buyer/w4-repo/pull/9',
        mergedAt: RECENT.toISOString(),
        mergeCommit,
        signedBy: `${AGENT_DID}#key-1`,
        buyer: BUYER_DID,
        additions: 186,
        deletions: 94,
        filesChanged: 9,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zw4-proof' },
  };
}

const jobRepo = new MemoryJobRepository();
const agentRepo = new MemoryAgentRepository();
const credentialRepo = new MemoryCredentialRepository();

await agentRepo.create({
  did: AGENT_DID,
  operatorDid: OPERATOR_DID,
  delegation: delegationFixture(AGENT_DID),
  name: 'axiom-ui',
  skills: ['design-systems'],
  githubLogin: 'axiom-ui-gh',
});

await jobRepo.create(jobFixture({ id: 'w4-job-draft', agentDid: AGENT_DID }));

await jobRepo.create(
  jobFixture({
    id: 'w4-job-submitted',
    agentDid: AGENT_DID,
    status: 'submitted',
    confirmedAt: RECENT,
    confirmedSpecHash: 'sha256:confirmed-spec',
    criteria: [{ text: 'It works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
    submittedAt: RECENT,
  }),
);

const completedJob = jobFixture({
  id: 'w4-job-completed',
  agentDid: AGENT_DID,
  status: 'completed',
  confirmedAt: RECENT,
  confirmedSpecHash: 'sha256:confirmed-spec-completed',
  criteria: [
    { text: 'All tests pass', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
    { text: 'No lint errors', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true },
  ],
  pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
  submittedAt: RECENT,
  stagedAt: RECENT,
  stagedCommit: 'w4stagedcommit',
  mergeCommit: 'w4cafefeed',
  mergedAt: RECENT,
});
await jobRepo.create(completedJob);
await credentialRepo.save({
  completedJobId: 'w4-job-completed',
  subjectDid: AGENT_DID,
  document: credentialDoc('w4-job-completed', 'w4cafefeed'),
  repositoryPublic: true,
});

await jobRepo.create(
  jobFixture({
    id: 'w4-job-closed-unmerged',
    agentDid: AGENT_DID,
    status: 'closed_unmerged',
    confirmedAt: RECENT,
    pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
    submittedAt: RECENT,
  }),
);

await jobRepo.create(
  jobFixture({
    id: 'w4-job-cited-closed',
    agentDid: AGENT_DID,
    status: 'cited_closed',
    confirmedAt: RECENT,
    criteria: [{ text: 'It works', proposedBy: 'agent', acceptedByBuyer: true, acceptedByAgent: true }],
    pullRequestUrl: 'https://github.com/buyer/w4-repo/pull/9',
    submittedAt: RECENT,
    citedCloseCriterionIndex: 0,
    citedCloseReasonText: 'The checkout flow is not actually fixed.',
    citedCloseAuthorDid: BUYER_DID,
    citedCloseAt: RECENT,
  }),
);

createApp(undefined, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo)
  .listen(PORT, '127.0.0.1', () => {
    console.log(`job fixtures serving on http://127.0.0.1:${PORT}`);
    console.log('  /jobs/w4-job-draft');
    console.log('  /jobs/w4-job-submitted');
    console.log('  /jobs/w4-job-completed');
    console.log('  /jobs/w4-job-closed-unmerged');
    console.log('  /jobs/w4-job-cited-closed');
  });
