// Invariant 2 (MISSION.md), Gate 2 for R-28: a third party can verify what
// this service stores without calling it. For a job draft the verifiable
// fact is the brief hash. A stranger holding ONLY the 201 response - the
// brief prose and the briefHash string - must be able to recompute the
// digest with off-the-shelf tools (node:crypto, openssl) and no call to
// this service.
//
// This file deliberately does not import the service's own hashing module.
// Verifying a hash with the code that produced it proves nothing: the
// normalisation below is written out independently from the documented
// contract (\n endings, trailing whitespace stripped per line, no final
// newline), so a divergence between documentation and implementation fails
// this test instead of being hidden by it. Model:
// tests/domain/job.test.ts ("the brief hash is re-computable off-platform").
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromRandom, type WalletObject } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import type { GithubAdapter, PullRequestSummary } from '../../src/adapters/github/types.js';
import { NotImplementedError } from '../../src/adapters/not-implemented.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { JobRepository } from '../../src/adapters/storage/types.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';
import { createJob, type Job } from '../../src/domain/job.js';

// The ArcBlock wallet's secretKey is seed(32)||public(32) in hex.
function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}

// Sign a W3C delegation credential using the operator's wallet key wrapped
// in Ed25519Signature2020 - what a compliant client produces. Same house
// construction as tests/api/agent-invariant2.test.ts.
async function signW3CDelegation(operator: WalletObject, agent: WalletObject): Promise<Record<string, unknown>> {
  const operatorDid = operator.toDid();
  const agentDid = agent.toDid();

  const seed = hexToBytes(operator.secretKey).slice(0, 32);
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: operatorDid });
  key.id = `${operatorDid}#${key.publicKeyMultibase}`;

  const suite = new Ed25519Signature2020({ key });

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: operatorDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: agentDid, delegatedBy: operatorDid },
  };

  const loader = securityLoader();
  loader.addStatic(key.id, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(operatorDid, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: operatorDid,
    assertionMethod: [key.id],
    verificationMethod: [
      {
        '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
        ...key.export({ publicKey: true }),
      },
    ],
  });
  const documentLoader = loader.build();

  const signed = await vc.issue({ credential, suite, documentLoader });
  return signed;
}

async function postJson(url: string, path: string, body: unknown, callerDid?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (callerDid !== undefined) headers['x-freeagents-caller-did'] = callerDid;
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('job draft, invariant 2 (R-28): the brief hash is verifiable off-platform', () => {
  let server: Server;
  let baseUrl: string;
  const operatorWallet = fromRandom();
  const agentWallet = fromRandom();

  // Operator and agent are built through the public routes exactly as the
  // agent-invariant2 suite does, so the draft hangs off a genuinely
  // delegated agent rather than a planted row.
  beforeAll(async () => {
    server = createApp(new MemoryOperatorRepository(), new MemoryAgentRepository()).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const reg = await postJson(baseUrl, '/operators', {
      did: operatorWallet.toDid(),
      githubLogin: 'operator-job-inv2',
    });
    expect(reg.status).toBe(201);

    const delegated = await postJson(baseUrl, '/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: await signW3CDelegation(operatorWallet, agentWallet),
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);
  });

  afterAll(() => {
    server.close();
  });

  it('a stranger recomputes briefHash from the response alone, no call to this service', async () => {
    // CRLF endings, a blank line, and trailing spaces: what a pasted buyer
    // message most plausibly carries.
    const brief = 'Fix the login bug on the checkout page\r\nthen deploy\r\n   \n  ';

    const res = await postJson(baseUrl, '/jobs', {
      buyerDid: operatorWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    // The response is the whole contract: exactly these fields, so a third
    // party knows brief travels beside briefHash on purpose.
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

    // Everything after this line uses body.brief and body.briefHash plus
    // node:crypto. Nothing else from the service, nothing from src/.
    expect(body.brief).toBe(brief);
    expect(typeof body.briefHash).toBe('string');

    // The documented normalisation, applied here independently: \n endings,
    // trailing whitespace stripped per line, no final newline.
    let normalised = String(body.brief)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
    if (normalised.endsWith('\n')) {
      normalised = normalised.slice(0, -1);
    }
    const recomputed = 'sha256:' + createHash('sha256').update(normalised).digest('hex');

    expect(recomputed).toBe(body.briefHash);
    expect(body.briefHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('negative control: an altered brief hashes differently, so this test can fail', async () => {
    // If the recomputation above could not disagree with the service, it
    // would prove nothing. One changed word must move the digest.
    const brief = 'Fix the login bug on the checkout page\r\n  ';
    const tampered = brief.replace('login', 'logout');

    const normalise = (s: string): string =>
      s
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n$/, '');

    const asStored = 'sha256:' + createHash('sha256').update(normalise(brief)).digest('hex');
    const asTampered = 'sha256:' + createHash('sha256').update(normalise(tampered)).digest('hex');

    expect(asTampered).not.toBe(asStored);
    expect(asStored).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(asTampered).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// Invariant 2 for the outcomes (R-12, ENT-7.2; withdrawn since R-31):
// the absence side. A stranger holding ONLY an outcome response -
// closed_unmerged, stale or withdrawn - must be able to tell off-platform
// that no hire is being claimed: the projection carries no mergeCommit and
// no mergedAt, and the brief hash still recomputes from the brief alone. An
// outcome that projected merge facts could be read as a verified hire,
// which is the failure this suite exists to catch.
describe('job outcome, invariant 2 (R-12): an unhappy outcome cannot read as a hire', () => {
  let server: Server;
  let baseUrl: string;
  const operatorWallet = fromRandom();
  const agentWallet = fromRandom();
  const FORK_OWNER = 'freeagents-platform';
  const FORK_REPO = 'target-repo';

  // The PR state is scripted per leg: the outcome comes from github's own
  // report, exactly as the merge route requires (ENT-7.1).
  let prState: PullRequestSummary['state'];
  const github: GithubAdapter = {
    getPullRequest: (ref) =>
      Promise.resolve({
        ref,
        state: prState,
        mergeCommitSha: null,
        mergedAt: null,
        headSha: 'head-sha-1',
        additions: 0,
        deletions: 0,
        filesChanged: 0,
      }),
    getMergeCommitSignature: () => Promise.reject(new NotImplementedError('github', 'getMergeCommitSignature')),
    getPublicGist: () => Promise.reject(new NotImplementedError('github', 'getPublicGist')),
    forkAndOpenPullRequest: () => Promise.resolve({ owner: FORK_OWNER, repo: FORK_REPO, number: 1 }),
  };

  beforeAll(async () => {
    server = createApp(new MemoryOperatorRepository(), new MemoryAgentRepository(), undefined, github, new MemoryJobRepository()).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const reg = await postJson(baseUrl, '/operators', {
      did: operatorWallet.toDid(),
      githubLogin: 'operator-outcome-inv2',
    });
    expect(reg.status).toBe(201);

    const delegated = await postJson(baseUrl, '/agents', {
      did: agentWallet.toDid(),
      operator: operatorWallet.toDid(),
      delegation: await signW3CDelegation(operatorWallet, agentWallet),
      name: 'scout',
      skills: ['triage'],
    });
    expect(delegated.status).toBe(201);
  });

  afterAll(() => {
    server.close();
  });

  async function walkToSubmitted(jobId: string): Promise<Record<string, unknown>> {
    expect(
      (
        await postJson(baseUrl, `/jobs/${jobId}/criteria`, {
          criteria: [
            { text: 'The login bug is fixed', proposedBy: 'agent' },
            { text: 'Checkout e2e test passes', proposedBy: 'buyer' },
          ],
        }, agentWallet.toDid())
      ).status,
    ).toBe(200);
    expect((await postJson(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, operatorWallet.toDid())).status).toBe(200);
    expect((await postJson(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agentWallet.toDid())).status).toBe(200);
    expect((await postJson(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, operatorWallet.toDid())).status).toBe(200);
    expect((await postJson(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agentWallet.toDid())).status).toBe(200);
    expect((await postJson(baseUrl, `/jobs/${jobId}/confirm`, {}, operatorWallet.toDid())).status).toBe(200);

    const pr = await postJson(baseUrl, `/jobs/${jobId}/pull-request`, {});
    expect(pr.status).toBe(200);
    const prBody = (await pr.json()) as Record<string, unknown>;
    expect(prBody.status).toBe('submitted');
    // The deadline rides the submission projection: a string a buyer can
    // hold against the wall clock, written by the domain 30 days out.
    expect(typeof prBody.deadline).toBe('string');
    return prBody;
  }

  it('a closed_unmerged outcome projects no merge facts, and briefHash still recomputes from it', async () => {
    const res = await postJson(baseUrl, '/jobs', {
      buyerDid: operatorWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(res.status).toBe(201);
    const jobId = String(((await res.json()) as Record<string, unknown>).id);
    await walkToSubmitted(jobId);

    prState = 'closed';
    const merge = await postJson(baseUrl, `/jobs/${jobId}/merge`, {});
    expect(merge.status).toBe(200);
    const body = (await merge.json()) as Record<string, unknown>;
    expect(body.status).toBe('closed_unmerged');

    // The absence side, asserted on the response alone: no merge fact is
    // present at all, not present as null. A response that carried merge
    // facts would let a stranger read this as a completed hire.
    expect('mergeCommit' in body).toBe(false);
    expect('mergedAt' in body).toBe(false);
    expect('mergeCommit' in (await (await fetch(`${baseUrl}/jobs/${jobId}`)).json() as Record<string, unknown>)).toBe(false);

    // And the response stays self-contained: the brief hash recomputes from
    // the projected brief with off-the-shelf tools, no call beyond this one.
    const normalised = String(body.brief).replace(/\s+$/, '');
    const recomputed = 'sha256:' + createHash('sha256').update(normalised).digest('hex');
    expect(recomputed).toBe(body.briefHash);
  });

  it('a stale outcome projects no merge facts either', async () => {
    // A submitted row whose deadline has already passed: relative to the
    // wall clock, so the leg holds under any run date. No honest HTTP path
    // can write this, so it is planted, the way the merge suite scripts its
    // unreachable rows.
    const submittedAt = new Date(Date.now() - 31 * 86_400_000);
    const planted: Job = {
      ...createJob(
        {
          id: 'j-outcome-stale',
          buyerDid: operatorWallet.toDid(),
          agentDid: agentWallet.toDid(),
          repository: 'buyer/target-repo',
          brief: 'Fix the login bug on the checkout page',
        },
        new Date(submittedAt.getTime() - 86_400_000),
      ),
      status: 'submitted',
      pullRequestUrl: `https://github.com/${FORK_OWNER}/${FORK_REPO}/pull/1`,
      submittedAt,
      deadline: new Date(submittedAt.getTime() + 30 * 86_400_000),
    };
    class PlantedJobRepository implements JobRepository {
      async create(): Promise<never> {
        throw new Error('unreachable');
      }
      async findById(id: string): Promise<Job | null> {
        return id === planted.id ? planted : null;
      }
      // The recorded outcome resolves: this leg asserts on the projection,
      // not on what storage did with the row.
      async update(row: Job): Promise<Job> {
        return row;
      }
      async complete(): Promise<never> {
        throw new Error('unreachable');
      }
      async findCompletedByJobId(): Promise<null> {
        return null;
      }
    }
    // complete's signature is part of the interface; the parameter types
    // keep the class honest without the leg ever running it.
    const repo = new PlantedJobRepository();

    const server2 = createApp(
      new MemoryOperatorRepository(),
      new MemoryAgentRepository(),
      undefined,
      github,
      repo,
    ).listen(0);
    await new Promise<void>((resolve) => server2.once('listening', resolve));
    const address = server2.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    const base = `http://127.0.0.1:${address.port}`;
    try {
      prState = 'open';
      const merge = await postJson(base, `/jobs/${planted.id}/merge`, {});
      expect(merge.status).toBe(200);
      const body = (await merge.json()) as Record<string, unknown>;
      expect(body.status).toBe('stale');
      expect(typeof body.deadline).toBe('string');
      expect('mergeCommit' in body).toBe(false);
      expect('mergedAt' in body).toBe(false);
    } finally {
      server2.close();
    }
  });

  it('a withdrawn outcome projects no merge facts, and briefHash still recomputes from it (R-31)', async () => {
    const res = await postJson(baseUrl, '/jobs', {
      buyerDid: operatorWallet.toDid(),
      agentDid: agentWallet.toDid(),
      repository: 'buyer/target-repo',
      brief: 'Fix the login bug on the checkout page',
    });
    expect(res.status).toBe(201);
    const jobId = String(((await res.json()) as Record<string, unknown>).id);
    await walkToSubmitted(jobId);

    const withdrawn = await postJson(baseUrl, `/jobs/${jobId}/withdraw`, {});
    expect(withdrawn.status).toBe(200);
    const body = (await withdrawn.json()) as Record<string, unknown>;
    expect(body.status).toBe('withdrawn');

    // The absence side, asserted on the response alone: a walk-away is a
    // timing fact, and one that carried merge facts could be read as a
    // completed hire.
    expect('mergeCommit' in body).toBe(false);
    expect('mergedAt' in body).toBe(false);
    expect('mergeCommit' in (await (await fetch(`${baseUrl}/jobs/${jobId}`)).json() as Record<string, unknown>)).toBe(false);

    // And the response stays self-contained: the brief hash recomputes from
    // the projected brief with off-the-shelf tools, no call beyond this one.
    const normalised = String(body.brief).replace(/\s+$/, '');
    const recomputed = 'sha256:' + createHash('sha256').update(normalised).digest('hex');
    expect(recomputed).toBe(body.briefHash);
  });
});
