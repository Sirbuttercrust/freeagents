import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';

const OPERATOR_DID = 'did:abt:zVisualOperator';
const AGENT_DID = 'did:abt:zVisualAgent';

function delegation(agentDid: string) {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:visual-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-08-30T00:00:00.000Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-08-30T00:00:00.000Z',
      verificationMethod: `${OPERATOR_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zProof',
    },
  };
}

function credentialDoc(id: string, subjectDid: string, repository: string, mergeCommit: string) {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: '2026-08-30T00:00:00.000Z',
    credentialSubject: {
      id: subjectDid,
      hire: {
        brief: 'sha256:brief',
        repository,
        pullRequest: `https://github.com/${repository}/pull/1`,
        mergedAt: '2026-08-30T00:00:00.000Z',
        mergeCommit,
        signedBy: `${subjectDid}#key-1`,
        buyer: 'did:example:visual-buyer',
        additions: 186,
        deletions: 94,
        filesChanged: 7,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zProof' },
  };
}

async function main() {
  const agentRepo = new MemoryAgentRepository();
  const jobRepo = new MemoryJobRepository();
  const credentialRepo = new MemoryCredentialRepository();

  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: delegation(AGENT_DID),
    name: 'axiom-ui',
    skills: ['React', 'TypeScript', 'Accessibility'],
    githubLogin: 'northsound',
  });

  const draft = {
    id: 'visual-job-1',
    buyerDid: 'did:example:visual-buyer',
    requestId: null,
    repository: 'buyer/visual-repo',
    brief: 'Fix the checkout flow',
    briefHash: 'sha256:brief',
    confirmedSpecHash: null,
    status: 'draft' as const,
    criteria: [],
    priceUsd: null,
    rail: null,
    priceAcceptedByBuyer: false,
    priceAcceptedByAgent: false,
    depositPercent: 25,
    redoAllowance: 1,
    redoUsedCount: 0,
    redoRequestedCriterionIndex: null,
    redoRequestedAt: null,
    redoRefusedAt: null,
    stagedLapseExtensionDays: 0,
    deliveryWindowDays: null,
    pullRequestUrl: null,
    mergeCommit: null,
    mergedAt: null,
    confirmedAt: null,
    submittedAt: null,
    deadline: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    stagedAt: null,
    stagedCommit: null,
    stagingRepo: null,
    baseCommit: null,
    stagingRepoDeleteAfter: null,
    citedCloseCriterionIndex: null,
    citedCloseReasonText: null,
    citedCloseAuthorDid: null,
    citedCloseAt: null,
    deemedCompletedAt: null,
    agentDid: AGENT_DID,
  };
  await jobRepo.create(draft);
  await jobRepo.complete(
    { ...draft, status: 'completed', mergeCommit: 'visualcafe', mergedAt: new Date('2026-08-30T00:00:00Z') },
    {
      jobId: draft.id,
      buyerDid: draft.buyerDid,
      agentDid: AGENT_DID,
      mergeCommit: 'visualcafe',
      completedAt: new Date('2026-08-30T00:00:00Z'),
    },
  );
  await credentialRepo.save({
    completedJobId: draft.id,
    subjectDid: AGENT_DID,
    document: credentialDoc('https://platform.example/v1/credentials/visual-job-1', AGENT_DID, 'buyer/visual-repo', 'visualcafe'),
    repositoryPublic: true,
  });

  const app = createApp(undefined, agentRepo, undefined, undefined, jobRepo, undefined, undefined, credentialRepo);
  const port = 3142;
  app.listen(port, '127.0.0.1', () => {
    console.log(`visual server on http://127.0.0.1:${port}/agents/${encodeURIComponent(AGENT_DID)}`);
  });
}

main();
