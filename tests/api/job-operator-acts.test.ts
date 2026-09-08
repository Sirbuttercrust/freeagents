// P8v: an operator acting on behalf of their own listed agent must be
// accepted as that agent's party on a job (2026-09-08 ruling, PLAN.md
// entry "an operator acting on behalf of their own listed agent should be
// accepted as that agent's party on a job"). partyForDid (src/api/app.ts)
// resolved a caller to 'agent' only when the acting DID equalled
// job.agentDid; a human operator signing in with a session resolves to
// their ACCOUNT DID, so every agent-side control used to be a 403 for the
// person who owns the agent. This file proves the operator relation
// closes that gap on the routes named in the brief (redo-refuse, stage)
// without opening a third party type or a new role string: the operator
// IS the agent's party, resolved through the existing isAgentOperator
// predicate (src/domain/agent.ts), exactly the way self-hire already
// resolves the operator to the buyer when the two coincide
// (buyer-diversity.test.ts's own pattern).
//
// Two sessioned servers share one jobRepo, one agentRepo and one
// attestationRepo (the same pattern tests/web/staged.test.ts's own
// "party and session gates" section uses for a stranger's session): one
// server's session adapter is bound to the agent's real operator login,
// the other's to an unrelated operator login, so both act against the
// SAME job row through two independently minted sessions.
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAgentRepository,
  MemoryAttestationRepository,
  MemoryJobRepository,
  MemoryAccountRepository,
  MemoryCredentialRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSession } from '../helpers/session-fixtures.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import type { Session } from '../../src/adapters/identity/session.js';

let buyer: SigningIdentity;
let agent: SigningIdentity;
const AGENT_GITHUB_LOGIN = 'scout-operator-acts';
const OPERATOR_LOGIN = 'operator-acts-owner';
const OTHER_OPERATOR_LOGIN = 'operator-acts-stranger';

const proposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
];

async function postSigned(base: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${base}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

async function postSession(base: string, path: string, body: unknown, session: Session): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify(body),
  });
}

async function walkToStaged(base: string): Promise<string> {
  const created = await postSigned(base, '/jobs', { agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
  expect(created.status).toBe(201);
  const jobId = String(((await created.json()) as Record<string, unknown>).id);
  expect((await postSigned(base, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/criteria/0/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/criteria/0/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/criteria/1/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/criteria/1/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/price/accept`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/price/accept`, {}, agent)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/confirm`, {}, buyer)).status).toBe(200);
  expect((await postSigned(base, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-1' }, agent)).status).toBe(200);
  return jobId;
}

describe('an operator acts for their own agent (P8v)', () => {
  let agentRepo: MemoryAgentRepository;
  let jobRepo: MemoryJobRepository;
  let attestationRepo: MemoryAttestationRepository;
  let operatorDid: string;

  let server: Server;
  let baseUrl: string;
  let operatorSession: Session;

  let otherServer: Server;
  let otherBaseUrl: string;
  let otherOperatorSession: Session;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(141));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(142));

    // The real operator's own server: its session adapter is bound to
    // OPERATOR_LOGIN, so a session minted against it resolves to the
    // account this agent's operatorDid names.
    const operatorAccountRepo = new MemoryAccountRepository();
    const operatorAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: OPERATOR_LOGIN, id: 87001 }),
    });
    operatorDid = 'did:abt:operator-acts-owner-account';
    await operatorAccountRepo.register({ did: operatorDid, githubLogin: OPERATOR_LOGIN });
    await operatorAccountRepo.register({ did: buyer.did, githubLogin: 'buyer-operator-acts-scripted' });

    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid,
      delegation: { fixture: true } as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: AGENT_GITHUB_LOGIN,
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: AGENT_GITHUB_LOGIN, status: 'verified' });

    jobRepo = new MemoryJobRepository();
    attestationRepo = new MemoryAttestationRepository();
    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter(undefined, credentialRepo);
    const { github } = createStagingLifecycleGithubFake();

    const app = createApp(
      operatorAccountRepo,
      agentRepo,
      undefined,
      github,
      jobRepo,
      credentials,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      operatorAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
      attestationRepo,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    operatorSession = await mintSession(operatorAdapter);

    // A second server, sharing the SAME agentRepo/jobRepo/attestationRepo
    // (the staged.test.ts stranger-session pattern), but with its own
    // account repo and session adapter bound to an unrelated operator
    // login: the different-operator 403 case.
    const otherAccountRepo = new MemoryAccountRepository();
    const otherAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: OTHER_OPERATOR_LOGIN, id: 87002 }),
    });
    await otherAccountRepo.register({ did: 'did:abt:operator-acts-stranger-account', githubLogin: OTHER_OPERATOR_LOGIN });
    otherServer = createApp(
      otherAccountRepo,
      agentRepo,
      undefined,
      github,
      jobRepo,
      credentials,
      undefined,
      credentialRepo,
      undefined,
      undefined,
      undefined,
      otherAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
      attestationRepo,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => otherServer.once('listening', resolve));
    const otherAddress = otherServer.address();
    if (otherAddress === null || typeof otherAddress === 'string') throw new Error('expected server to listen on a port');
    otherBaseUrl = `http://127.0.0.1:${otherAddress.port}`;
    otherOperatorSession = await mintSession(otherAdapter);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => otherServer.close(() => resolve()));
  });

  it("the operator's own session accepts a redo (restages) on their agent's job (200)", async () => {
    const jobId = await walkToStaged(baseUrl);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    const res = await postSession(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-2' }, operatorSession);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('staged');
  });

  it("the operator's own session refuses a redo on their agent's job (200)", async () => {
    const jobId = await walkToStaged(baseUrl);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    const res = await postSession(baseUrl, `/jobs/${jobId}/redo-refuse`, {}, operatorSession);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('staged');
    expect((body.redo as Record<string, unknown>).refusedAt).not.toBeNull();
  });

  it("a different operator's session is 403 on this agent's redo", async () => {
    const jobId = await walkToStaged(baseUrl);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    const res = await postSession(otherBaseUrl, `/jobs/${jobId}/redo-refuse`, {}, otherOperatorSession);
    expect(res.status).toBe(403);
  });

  it("the agent's own signing key still works after the operator relation lands", async () => {
    const jobId = await walkToStaged(baseUrl);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    const res = await postSigned(baseUrl, `/jobs/${jobId}/redo-refuse`, {}, agent);
    expect(res.status).toBe(200);
  });

  it('the credential subject and signer matching are unchanged when the operator stages the work', async () => {
    const jobId = await walkToStaged(baseUrl);
    expect((await postSigned(baseUrl, `/jobs/${jobId}/redo`, { criterionIndex: 0 }, buyer)).status).toBe(200);
    const res = await postSession(baseUrl, `/jobs/${jobId}/stage`, { stagedCommit: 'commit-sha-3' }, operatorSession);
    expect(res.status).toBe(200);
    const all = await attestationRepo.listByJobId(jobId);
    const latest = all[all.length - 1];
    // The attestation still names the AGENT's own signed identity, never
    // the operator: commitSigners is measured against the agent's own
    // verified GitHub login regardless of who pressed the button.
    expect(latest?.attestation.commitSigners.every((s) => s.matchesAgentDid === true)).toBe(true);
  });

  it('an operator who is also the job\'s buyer cannot act as agent on it (the buyer check wins)', async () => {
    // The dual-role account: registered as an account that is BOTH this
    // agent's operator and the job's buyer. isSelfHire's own rule (buyer
    // === operator) already refuses this pairing at the domain layer;
    // this test confirms the route-level party resolution never lets the
    // operator relation override the buyer match on the SAME job.
    const dualAccountRepo = new MemoryAccountRepository();
    const dualAdapter = createSessionAdapter({
      github: fakeGitHubConfig(),
      fetchImpl: fakeGitHubFetch({ login: 'operator-acts-dual-role', id: 87003 }),
    });
    const dualSession = await mintSession(dualAdapter);
    const dualDid = 'did:abt:operator-acts-dual-role-account';
    await dualAccountRepo.register({ did: dualDid, githubLogin: 'operator-acts-dual-role' });

    const dualAgentRepo = new MemoryAgentRepository();
    const dualAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(143));
    await dualAgentRepo.create({
      did: dualAgent.did,
      operatorDid: dualDid,
      delegation: { fixture: true } as never,
      name: 'scout-dual',
      skills: ['triage'],
      githubLogin: 'scout-operator-acts-dual',
    });
    await dualAgentRepo.updateGithubBinding(dualAgent.did, { handle: 'scout-operator-acts-dual', status: 'verified' });

    const dualJobRepo = new MemoryJobRepository();
    const dualCredentialRepo = new MemoryCredentialRepository();
    const dualCredentials = createCredentialsAdapter(undefined, dualCredentialRepo);
    const { github: dualGithub } = createStagingLifecycleGithubFake();
    const dualServer = createApp(
      dualAccountRepo,
      dualAgentRepo,
      undefined,
      dualGithub,
      dualJobRepo,
      dualCredentials,
      undefined,
      dualCredentialRepo,
      undefined,
      undefined,
      undefined,
      dualAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
      new MemoryAttestationRepository(),
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => dualServer.once('listening', resolve));
    const dualAddress = dualServer.address();
    if (dualAddress === null || typeof dualAddress === 'string') throw new Error('expected server to listen on a port');
    const dualBaseUrl = `http://127.0.0.1:${dualAddress.port}`;
    try {
      // The dual-role account hires ITS OWN agent, signed in with the
      // SAME session both as the requesting party and as the operator
      // this agent names. requireSessionOrSignature resolves the acting
      // party from the session first (POST /jobs, buyer-only route), so
      // this creates a job whose buyerDid equals the agent's operatorDid.
      const created = await postSession(dualBaseUrl, '/jobs', { agentDid: dualAgent.did, repository: 'buyer/target-repo', brief: 'Self-hire' }, dualSession);
      expect(created.status).toBe(201);
      const jobId = String(((await created.json()) as Record<string, unknown>).id);
      expect((await postSigned(dualBaseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, dualAgent)).status).toBe(200);

      // The dual-role session tries to act as the AGENT on this same
      // job's criteria acceptance (a route that requires the resolved
      // party to be 'agent'). It resolves to the buyer party (the
      // resolved DID equals job.buyerDid, checked before the agent leg),
      // so it is refused as the agent -- the operator relation never
      // gets a chance to grant it, exactly as isSelfHire's own header
      // comment says the job "was never confirmable anyway".
      const acceptAsAgent = await postSession(dualBaseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, dualSession);
      expect(acceptAsAgent.status).toBe(200);
      const acceptedBody = (await acceptAsAgent.json()) as Record<string, unknown>;
      const criteria = acceptedBody.criteria as Array<Record<string, unknown>>;
      // Accepted as the BUYER (acceptedByBuyer flips), never as the agent
      // (acceptedByAgent stays false): the buyer match wins over the
      // operator relation for this same acting DID on this same job.
      expect(criteria[0]?.acceptedByBuyer).toBe(true);
      expect(criteria[0]?.acceptedByAgent).toBe(false);
    } finally {
      await new Promise<void>((resolve) => dualServer.close(() => resolve()));
    }
  });
});
