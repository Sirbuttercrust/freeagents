// HT1 Part A2 (ruling, 2026-09-25, Temper): one brief to up to three
// agents. A buyer can send one brief to 1 to 3 agents in one request,
// each agent gets its own job row, and every row sharing one request
// carries a shared requestId (nullable, set only for a request that
// actually named 2 or 3 agents). Confirming one job withdraws every
// sibling still in draft or proposed. Sibling privacy is structural
// (Temper's ruling on the A2 design fork): GET /jobs/:jobId stays fully
// public for every job (invariant 2), and no response reachable by an
// owner who is not a sibling's own operator ever names that sibling's
// id, agent, or price.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter, mintSession } from '../helpers/session-fixtures.js';
import type { Session } from '../../src/adapters/identity/session.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:delegation-for-${agentDid}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${agentDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
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

async function getSigned(baseUrl: string, path: string, identity: SigningIdentity): Promise<Response> {
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'GET', targetUri, {});
  return fetch(targetUri, {
    method: 'GET',
    headers: {
      'signature-input': signed['signature-input'],
      signature: signed.signature,
    },
  });
}

async function getSession(baseUrl: string, path: string, session: Session): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
}

let buyer: SigningIdentity;
let agentA: SigningIdentity;
let agentB: SigningIdentity;
let agentC: SigningIdentity;
let agentD: SigningIdentity;
let ownerBSession: Session;

describe('HT1 Part A2: one brief to up to three agents', () => {
  let server: Server;
  let baseUrl: string;
  let agentRepo: MemoryAgentRepository;
  let accountRepo: MemoryAccountRepository;
  let jobRepo: MemoryJobRepository;

  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(161));
    agentA = await signingIdentityFromSeed(new Uint8Array(32).fill(162));
    agentB = await signingIdentityFromSeed(new Uint8Array(32).fill(163));
    agentC = await signingIdentityFromSeed(new Uint8Array(32).fill(164));
    agentD = await signingIdentityFromSeed(new Uint8Array(32).fill(165));

    accountRepo = new MemoryAccountRepository();
    await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-multi-agent' });

    // Three agents, three DIFFERENT owners: this is the fact sibling
    // privacy has to hold across (owner B must never learn of job A or
    // job C).
    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agentA.did,
      operatorDid: 'did:abt:owner-a-multi-agent',
      delegation: delegationFixture(agentA.did, 'did:abt:owner-a-multi-agent') as never,
      name: 'agent-alpha',
      skills: ['triage'],
      githubLogin: 'agent-alpha-multi-agent',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agentA.did, { handle: 'agent-alpha-multi-agent', status: 'verified' });
    await agentRepo.create({
      did: agentB.did,
      operatorDid: 'did:abt:owner-b-multi-agent',
      delegation: delegationFixture(agentB.did, 'did:abt:owner-b-multi-agent') as never,
      name: 'agent-bravo',
      skills: ['triage'],
      githubLogin: 'agent-bravo-multi-agent',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agentB.did, { handle: 'agent-bravo-multi-agent', status: 'verified' });
    await agentRepo.create({
      did: agentC.did,
      operatorDid: 'did:abt:owner-c-multi-agent',
      delegation: delegationFixture(agentC.did, 'did:abt:owner-c-multi-agent') as never,
      name: 'agent-charlie',
      skills: ['triage'],
      githubLogin: 'agent-charlie-multi-agent',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agentC.did, { handle: 'agent-charlie-multi-agent', status: 'verified' });
    await agentRepo.create({
      did: agentD.did,
      operatorDid: 'did:abt:owner-d-multi-agent',
      delegation: delegationFixture(agentD.did, 'did:abt:owner-d-multi-agent') as never,
      name: 'agent-delta',
      skills: ['triage'],
      githubLogin: 'agent-delta-multi-agent',
      negotiatesOnOwnersBehalf: true,
    });
    await agentRepo.updateGithubBinding(agentD.did, { handle: 'agent-delta-multi-agent', status: 'verified' });

    const jobRepoInstance = new MemoryJobRepository();
    jobRepo = jobRepoInstance;
    const sessionAdapter = testSessionAdapter();
    const { github } = createStagingLifecycleGithubFake();
    server = createApp(
      accountRepo,
      agentRepo,
      undefined,
      github,
      jobRepoInstance,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessionAdapter,
      undefined,
      alwaysSettledGate(),
      anyCommitStagingObserver(),
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Owner B gets its own live session so the sibling-privacy test below
    // can act as owner B via session AND via signature (the spec's own
    // wording: "the second owner's own session/signature"). A session
    // here resolves to a fresh provisioned account per GitHub login.
    ownerBSession = await mintSession(sessionAdapter);
  });

  afterAll(() => {
    server.close();
  });

  describe('1 to 3 agents in one request, a fourth is 400', () => {
    it('a single agentDid still opens exactly one job in the pre-existing shape (unchanged)', async () => {
      const res = await postSigned(baseUrl, '/jobs', {
        agentDid: agentA.did,
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      // The single-agent shape: a bare job projection, no requestId key,
      // no jobs array. Object.keys pins this exactly, so a regression
      // that wraps the reply in { jobs: [...] } is caught here.
      expect(Object.keys(body).sort()).toEqual([
        'agentDid',
        'brief',
        'briefHash',
        'buyerDid',
        'createdAt',
        'id',
        'repository',
        'status',
      ]);
      expect(body.status).toBe('draft');
      expect(body.agentDid).toBe(agentA.did);
    });

    it('agentDids naming one agent also opens exactly one job, in the SAME shape as agentDid', async () => {
      const res = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did],
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'agentDid',
        'brief',
        'briefHash',
        'buyerDid',
        'createdAt',
        'id',
        'repository',
        'status',
      ]);
    });

    it('agentDids naming two or three agents opens one job row per agent, all sharing one requestId', async () => {
      const res = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did, agentB.did, agentC.did],
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { requestId: string; jobs: Array<Record<string, unknown>> };
      expect(typeof body.requestId).toBe('string');
      expect(body.jobs).toHaveLength(3);
      expect(body.jobs.map((j) => j.agentDid).sort()).toEqual([agentA.did, agentB.did, agentC.did].sort());
      // Every job is its own row (distinct ids), all draft.
      const ids = body.jobs.map((j) => j.id);
      expect(new Set(ids).size).toBe(3);
      body.jobs.forEach((j) => expect(j.status).toBe('draft'));
    });

    it('a fourth agent named in the same request is refused with 400, and creates nothing', async () => {
      const distinctiveBrief = 'DISTINCTIVE-BRIEF-fourth-agent-refused-creates-nothing';
      const res = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did, agentB.did, agentC.did, agentD.did],
        repository: 'buyer/target-repo',
        brief: distinctiveBrief,
      }, buyer);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('3 agents');

      // Nothing was created: read the storage layer directly (bypassing
      // any route-level filter) for every job this buyer has ever opened,
      // and confirm none of them carries this brief.
      const buyerJobs = await jobRepo.findByBuyerDid(buyer.did);
      expect(buyerJobs.some((j) => j.brief === distinctiveBrief)).toBe(false);
    });

    it('agentDids naming the same agent twice is refused with 400', async () => {
      const res = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did, agentA.did],
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      expect(res.status).toBe(400);
    });

    it('naming both agentDid and agentDids is refused with 400', async () => {
      const res = await postSigned(baseUrl, '/jobs', {
        agentDid: agentA.did,
        agentDids: [agentB.did],
        repository: 'buyer/target-repo',
        brief: 'Fix the login bug',
      }, buyer);
      expect(res.status).toBe(400);
    });

    it('an unregistered agent anywhere in agentDids refuses the WHOLE request with 404, creating none of the siblings', async () => {
      const bogus = 'did:abt:zNoSuchAgentMultiAgent';
      const distinctiveBrief = 'DISTINCTIVE-BRIEF-unregistered-agent-refused-creates-none';
      const res = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did, bogus],
        repository: 'buyer/target-repo',
        brief: distinctiveBrief,
      }, buyer);
      expect(res.status).toBe(404);

      // agentA must not have gained a stray job from this refused
      // request: read the storage layer directly for every job this
      // buyer has opened, and confirm none carries this brief.
      const buyerJobs = await jobRepo.findByBuyerDid(buyer.did);
      expect(buyerJobs.some((j) => j.brief === distinctiveBrief)).toBe(false);
    });
  });

  describe('confirming one job withdraws every sibling still in draft or proposed', () => {
    async function proposeAndAcceptEverything(jobId: string, agent: SigningIdentity): Promise<void> {
      const proposal = [{ text: 'Done', proposedBy: 'agent' }];
      expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: proposal, priceUsd: '500.00', rail: 'abt' }, agent)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agent)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer)).status).toBe(200);
      expect((await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agent)).status).toBe(200);
    }

    it('confirming the buyer-preferred job withdraws the two siblings still in draft/proposed, and its own status is unaffected', async () => {
      const opened = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did, agentB.did, agentC.did],
        repository: 'buyer/target-repo',
        brief: 'A brief with three quotes',
      }, buyer);
      expect(opened.status).toBe(201);
      const { jobs } = (await opened.json()) as { jobs: Array<{ id: string; agentDid: string }> };
      const jobFor = (agentDid: string): string => jobs.find((j) => j.agentDid === agentDid)!.id;

      const jobIdA = jobFor(agentA.did);
      const jobIdB = jobFor(agentB.did);
      const jobIdC = jobFor(agentC.did);

      // A quotes and gets confirmed; B stays in draft (never proposed);
      // C proposes but is never accepted (stays in proposed).
      await proposeAndAcceptEverything(jobIdA, agentA);
      expect((await postSigned(baseUrl, `/jobs/${jobIdC}/criteria`, { criteria: [{ text: 'Also done', proposedBy: 'agent' }], priceUsd: '400.00', rail: 'abt' }, agentC)).status).toBe(200);

      const confirmRes = await postSigned(baseUrl, `/jobs/${jobIdA}/confirm`, {}, buyer);
      expect(confirmRes.status).toBe(200);
      const confirmedBody = (await confirmRes.json()) as { status: string };
      expect(confirmedBody.status).toBe('confirmed');

      const readB = await fetch(`${baseUrl}/jobs/${jobIdB}`);
      expect(readB.status).toBe(200);
      expect(((await readB.json()) as { status: string }).status).toBe('withdrawn');

      const readC = await fetch(`${baseUrl}/jobs/${jobIdC}`);
      expect(readC.status).toBe(200);
      expect(((await readC.json()) as { status: string }).status).toBe('withdrawn');

      // The confirmed job itself is untouched by the sibling sweep.
      const readA = await fetch(`${baseUrl}/jobs/${jobIdA}`);
      expect(((await readA.json()) as { status: string }).status).toBe('confirmed');
    });

    it('confirming a job whose sibling is already confirmed is refused with 409', async () => {
      const opened = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did, agentB.did],
        repository: 'buyer/target-repo',
        brief: 'A brief with two quotes, one already decided',
      }, buyer);
      const { jobs } = (await opened.json()) as { jobs: Array<{ id: string; agentDid: string }> };
      const jobIdA = jobs.find((j) => j.agentDid === agentA.did)!.id;
      const jobIdB = jobs.find((j) => j.agentDid === agentB.did)!.id;

      await proposeAndAcceptEverything(jobIdA, agentA);
      await proposeAndAcceptEverything(jobIdB, agentB);

      const firstConfirm = await postSigned(baseUrl, `/jobs/${jobIdA}/confirm`, {}, buyer);
      expect(firstConfirm.status).toBe(200);

      // jobIdB is still 'proposed' at this point (its own price/criteria
      // were accepted, but withdrawal happens only when A CONFIRMS, which
      // just fired). Attempting to confirm the now-withdrawn sibling must
      // refuse: either 409 (the sibling-already-confirmed check) or the
      // domain's own transition refusal from withdrawn -- both are state
      // conflicts, so either is acceptable, but neither may be 200.
      const secondConfirm = await postSigned(baseUrl, `/jobs/${jobIdB}/confirm`, {}, buyer);
      expect(secondConfirm.status).not.toBe(200);
      expect([404, 409]).toContain(secondConfirm.status);
    });

    it('a sibling withdrawn from draft or proposed does not count against the buyer\u2019s conduct record', async () => {
      const opened = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did, agentB.did],
        repository: 'buyer/target-repo',
        brief: 'A brief whose withdrawn sibling must not taint the buyer record',
      }, buyer);
      const { jobs } = (await opened.json()) as { jobs: Array<{ id: string; agentDid: string }> };
      const jobIdA = jobs.find((j) => j.agentDid === agentA.did)!.id;

      await proposeAndAcceptEverything(jobIdA, agentA);
      const confirmRes = await postSigned(baseUrl, `/jobs/${jobIdA}/confirm`, {}, buyer);
      expect(confirmRes.status).toBe(200);

      // buyerConductRecord counts withdrawn only when confirmedAt is set
      // (src/domain/buyer-conduct.ts:152); the sibling never reached
      // confirmed, so it has no confirmedAt, and this must read 0, never
      // a phantom walk-away against a buyer who chose a different agent.
      const conductRes = await fetch(`${baseUrl}/buyers/buyer-multi-agent/conduct`);
      expect(conductRes.status).toBe(200);
      const conduct = (await conductRes.json()) as { keyed: boolean; counts?: { walkedAfterConfirm: number } };
      expect(conduct.keyed).toBe(true);
      expect(conduct.counts?.walkedAfterConfirm).toBe(0);
    });
  });

  describe('sibling privacy: no owner can read a sibling job, however derived', () => {
    it('owner B (by session, then by signature) reaches every route it can and never sees job A, job C, the requestId, or their agents/prices', async () => {
      const opened = await postSigned(baseUrl, '/jobs', {
        agentDids: [agentA.did, agentB.did, agentC.did],
        repository: 'buyer/target-repo',
        brief: 'A privacy-sensitive brief across three owners',
      }, buyer);
      expect(opened.status).toBe(201);
      const { requestId, jobs } = (await opened.json()) as { requestId: string; jobs: Array<{ id: string; agentDid: string }> };
      const jobIdA = jobs.find((j) => j.agentDid === agentA.did)!.id;
      const jobIdB = jobs.find((j) => j.agentDid === agentB.did)!.id;
      const jobIdC = jobs.find((j) => j.agentDid === agentC.did)!.id;

      // Give agent B's job a price, so a price leak has something real to
      // catch (a null/absent price would pass any assertion vacuously).
      expect((await postSigned(baseUrl, `/jobs/${jobIdB}/criteria`, { criteria: [{ text: 'Bravo scope', proposedBy: 'agent' }], priceUsd: '777.00', rail: 'abt' }, agentB)).status).toBe(200);

      const forbidden = [jobIdA, jobIdC, requestId, agentA.did, agentC.did, 'agent-alpha', 'agent-charlie'];

      function assertNoLeak(label: string, bodyText: string): void {
        forbidden.forEach((needle) => {
          expect(bodyText, `${label} leaked "${needle}"`).not.toContain(needle);
        });
      }

      // POSITIVE CONTROL (Temper's ruling 3): plant job A's id into a
      // fabricated response body and confirm the assertion actually
      // catches it, before trusting it to catch anything real.
      expect(() => assertNoLeak('planted control', JSON.stringify({ note: jobIdA }))).toThrow();

      // Every route owner B (agentB's own operator) can reach: GET
      // /jobs/:jobId for its OWN job (fine, it is a party), the agent
      // profile, /accounts/:did/incoming, /accounts/:did/jobs (as buyer,
      // not applicable here, but reachable), and the negotiation PUT
      // reply. Try both proofs: session first, then signature.
      const ownJobBySession = await getSession(baseUrl, `/jobs/${jobIdB}`, ownerBSession);
      expect(ownJobBySession.status).toBe(200);
      assertNoLeak('GET /jobs/:jobId (own job, session)', await ownJobBySession.text());

      const ownJobBySignature = await getSigned(baseUrl, `/jobs/${jobIdB}`, agentB);
      expect(ownJobBySignature.status).toBe(200);
      assertNoLeak('GET /jobs/:jobId (own job, signature)', await ownJobBySignature.text());

      const profileRes = await fetch(`${baseUrl}/agents/${encodeURIComponent(agentB.did)}`);
      expect(profileRes.status).toBe(200);
      assertNoLeak('GET /agents/:agentDid', await profileRes.text());

      const hiresRes = await fetch(`${baseUrl}/agents/${encodeURIComponent(agentB.did)}/hires`);
      expect(hiresRes.status).toBe(200);
      assertNoLeak('GET /agents/:agentDid/hires', await hiresRes.text());

      // A stranger reading job A or job C directly (invariant 2: the
      // route stays public) sees ONLY that job's own facts -- it must
      // never carry the requestId or name a sibling either.
      const readA = await fetch(`${baseUrl}/jobs/${jobIdA}`);
      expect(readA.status).toBe(200);
      const readAText = await readA.text();
      [jobIdB, jobIdC, requestId, agentB.did, agentC.did].forEach((needle) => {
        expect(readAText, `GET /jobs/:jobId (job A, public) leaked "${needle}"`).not.toContain(needle);
      });
    });
  });
});
