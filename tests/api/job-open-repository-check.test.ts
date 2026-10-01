// POST /jobs reads the request's one repository before any hire opens, and
// refuses with 409 (zero jobs written, nobody notified) when the platform
// cannot take the work: not visible to the platform, private on a
// personal account, private with organization forking off, or empty. No
// job exists yet, so none of the four sentences carries a ?job= address,
// and the not-visible one cannot name a single agent (a brief may go to
// three). A GitHub failure does not refuse a brief: a brief moves no money,
// and the deposit doors and confirm each read the repository again before
// anything is paid or staged, so the failure is logged for the operator and
// the hire opens as it always did. One read per request, however many
// agents it names, and only after every cheaper refusal has passed.
//
// Real listening servers and signed parties, the pattern of
// job-deposit-repository-check.test.ts.
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createGithubAdapter } from '../../src/adapters/github/github.js';
import type { GithubAdapter, RepositoryFacts, StagingRepoRef } from '../../src/adapters/github/types.js';
import { RepositoryEmptyError, RepositoryNotAccessibleError } from '../../src/adapters/github/types.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryNotificationRepository,
} from '../../src/adapters/storage/memory.js';
import type { Job } from '../../src/domain/job.js';
import { createStagingLifecycleGithubFake, PLATFORM_LOGIN } from '../helpers/github-staging-fixtures.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const PUBLIC_BASE = 'https://brief.example';
const REPOSITORY = 'buyer/brief-repo';
const BRIEF = 'Fix the login bug';

const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(171));
const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(172));
const agentIdentities = [
  await signingIdentityFromSeed(new Uint8Array(32).fill(173)),
  await signingIdentityFromSeed(new Uint8Array(32).fill(174)),
  await signingIdentityFromSeed(new Uint8Array(32).fill(175)),
];
const unregisteredAgent = await signingIdentityFromSeed(new Uint8Array(32).fill(176));

function agentLogin(index: number): string {
  return `scout-open-repo-check-${String(index)}`;
}
function operatorDid(index: number): string {
  return `did:abt:op-open-repo-check-${String(index)}`;
}

// The four sentences a buyer is told at the brief, written out in full so a
// reworded sentence fails here rather than passing through a shared helper.
const NOT_VISIBLE_SENTENCE =
  `the platform cannot see this repository; for a private repository it must live in a GitHub organization ` +
  `that gives read access to the platform's GitHub account (${PLATFORM_LOGIN}) and to the GitHub account of ` +
  `each agent you hire; how to share it: ${PUBLIC_BASE}/private-repos`;
const PERSONAL_ACCOUNT_SENTENCE =
  `this repository is private and owned by a personal account; a private repository must live in a GitHub ` +
  `organization, where agents get a read-only role: ${PUBLIC_BASE}/private-repos`;
const FORKING_OFF_SENTENCE =
  `this repository is private and forking of private repositories is off in the organization's settings; ` +
  `ask the organization owner to turn it on, or share access another way: ${PUBLIC_BASE}/private-repos`;
const EMPTY_SENTENCE = 'this repository has no commits yet; it needs one starting commit before work can land in it';

class CountingJobRepository extends MemoryJobRepository {
  creates = 0;
  override async create(job: Job): Promise<Job> {
    this.creates += 1;
    return super.create(job);
  }
}

interface Reads {
  readonly github: GithubAdapter;
  readonly reads: StagingRepoRef[];
}

// A github fake whose readRepository answers `answer`, counting every call.
function githubReading(answer: () => Promise<RepositoryFacts>): Reads {
  const { github } = createStagingLifecycleGithubFake();
  const reads: StagingRepoRef[] = [];
  return {
    github: {
      ...github,
      readRepository: async (ref) => {
        reads.push(ref);
        return answer();
      },
    },
    reads,
  };
}

function readyFacts(overrides: Partial<RepositoryFacts> = {}): RepositoryFacts {
  return {
    fullName: REPOSITORY,
    private: false,
    allowForking: true,
    ownerIsOrganization: true,
    defaultBranch: 'main',
    sha: 'ready-sha',
    ...overrides,
  };
}

interface Started {
  readonly baseUrl: string;
  readonly server: Server;
  readonly jobRepo: CountingJobRepository;
  readonly notificationRepo: MemoryNotificationRepository;
}

interface StartOptions {
  readonly agentCount?: number;
  readonly unlistedAgentIndex?: number;
  readonly conductGatedAgentIndex?: number;
}

async function startApp(github: GithubAdapter, options: StartOptions = {}): Promise<Started> {
  const accountRepo = new MemoryAccountRepository();
  await accountRepo.register({ did: buyer.did, githubLogin: 'buyer-open-repo-check' });
  const agentRepo = new MemoryAgentRepository();
  const agentCount = options.agentCount ?? 3;
  for (let i = 0; i < agentCount; i += 1) {
    const identity = agentIdentities[i]!;
    await agentRepo.create({
      did: identity.did,
      operatorDid: operatorDid(i),
      delegation: { fixture: true } as never,
      name: `scout-${String(i)}`,
      skills: ['triage'],
      githubLogin: agentLogin(i),
      negotiatesOnOwnersBehalf: true,
      ...(options.conductGatedAgentIndex === i ? { minBuyerMerges: 1 } : {}),
    });
    await agentRepo.updateGithubBinding(identity.did, { handle: agentLogin(i), status: 'verified' });
    if (options.unlistedAgentIndex === i) await agentRepo.setListed(identity.did, false);
  }
  const jobRepo = new CountingJobRepository();
  const notificationRepo = new MemoryNotificationRepository();
  const app = createApp(
    accountRepo,
    agentRepo,
    undefined,
    github,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    notificationRepo,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, server, jobRepo, notificationRepo };
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

function briefBody(agentCount: number): Record<string, unknown> {
  if (agentCount === 1) return { agentDid: agentIdentities[0]!.did, repository: REPOSITORY, brief: BRIEF };
  return {
    agentDids: agentIdentities.slice(0, agentCount).map((identity) => identity.did),
    repository: REPOSITORY,
    brief: BRIEF,
  };
}

function expectedJob(index: number): Record<string, unknown> {
  return {
    id: expect.stringMatching(/^j-[0-9a-f]{16}$/),
    buyerDid: buyer.did,
    agentDid: agentIdentities[index]!.did,
    repository: REPOSITORY,
    brief: BRIEF,
    briefHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    status: 'draft',
    createdAt: expect.any(String),
    githubAccessNeeded: { agentGithubLogin: agentLogin(index), platformGithubLogin: PLATFORM_LOGIN },
  };
}

function expectedBody(agentCount: number): Record<string, unknown> {
  if (agentCount === 1) return expectedJob(0);
  return {
    requestId: expect.stringMatching(/^req-[0-9a-f]{16}$/),
    jobs: Array.from({ length: agentCount }, (_, i) => expectedJob(i)),
  };
}

async function notificationCount(started: Started): Promise<number> {
  let total = 0;
  for (let i = 0; i < 3; i += 1) total += (await started.notificationRepo.listByAccountDid(operatorDid(i))).length;
  return total;
}

let active: Started | null = null;
let previousBase: string | undefined;
beforeEach(() => {
  previousBase = process.env.FREEAGENTS_PUBLIC_BASE_URL;
  process.env.FREEAGENTS_PUBLIC_BASE_URL = PUBLIC_BASE;
});
afterEach(async () => {
  if (previousBase === undefined) delete process.env.FREEAGENTS_PUBLIC_BASE_URL;
  else process.env.FREEAGENTS_PUBLIC_BASE_URL = previousBase;
  if (active !== null) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = null;
  }
  vi.restoreAllMocks();
});

async function expectRefusedBrief(started: Started, agentCount: number, sentence: string): Promise<void> {
  const res = await postSigned(started.baseUrl, '/jobs', briefBody(agentCount), buyer);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: sentence });
  expect(started.jobRepo.creates).toBe(0);
  expect(await notificationCount(started)).toBe(0);
}

const requestSizes = [1, 3] as const;

describe.each(requestSizes)('(a) a repository the platform cannot see, a brief naming %i agent(s)', (agentCount) => {
  it.each([404, 403] as const)('answers 409 with the brief-time sentence on a GitHub %i, opens no hire, notifies nobody', async (status) => {
    const { github } = githubReading(() => Promise.reject(new RepositoryNotAccessibleError('buyer', 'brief-repo', status)));
    active = await startApp(github, { agentCount });
    await expectRefusedBrief(active, agentCount, NOT_VISIBLE_SENTENCE);
  });

  it('names no job address and no agent account in the sentence', async () => {
    const { github } = githubReading(() => Promise.reject(new RepositoryNotAccessibleError('buyer', 'brief-repo', 404)));
    active = await startApp(github, { agentCount });
    const res = await postSigned(active.baseUrl, '/jobs', briefBody(agentCount), buyer);
    const { error } = (await res.json()) as { error: string };
    expect(error).not.toContain('?job=');
    for (let i = 0; i < agentCount; i += 1) {
      expect(error).not.toContain(agentLogin(i));
      expect(error).not.toContain(agentIdentities[i]!.did);
    }
  });
});

describe('(b) a private repository on a personal account', () => {
  it.each(requestSizes)('answers 409 with the sentence ending at /private-repos, opens no hire (%i agent(s))', async (agentCount) => {
    const { github } = githubReading(async () => readyFacts({ private: true, ownerIsOrganization: false }));
    active = await startApp(github, { agentCount });
    await expectRefusedBrief(active, agentCount, PERSONAL_ACCOUNT_SENTENCE);
    expect(PERSONAL_ACCOUNT_SENTENCE.endsWith('/private-repos')).toBe(true);
  });
});

describe('(c) a private repository whose organization has forking off', () => {
  it.each(requestSizes)('answers 409 with the sentence ending at /private-repos, opens no hire (%i agent(s))', async (agentCount) => {
    const { github } = githubReading(async () => readyFacts({ private: true, allowForking: false }));
    active = await startApp(github, { agentCount });
    await expectRefusedBrief(active, agentCount, FORKING_OFF_SENTENCE);
    expect(FORKING_OFF_SENTENCE.endsWith('/private-repos')).toBe(true);
  });
});

describe('(d) an empty repository', () => {
  it.each(requestSizes)('answers 409 with the no-commits sentence, opens no hire (%i agent(s))', async (agentCount) => {
    const { github } = githubReading(() => Promise.reject(new RepositoryEmptyError('buyer', 'brief-repo')));
    active = await startApp(github, { agentCount });
    await expectRefusedBrief(active, agentCount, EMPTY_SENTENCE);
  });
});

describe('(e) GitHub failing does not refuse a brief', () => {
  it('a plain Error from the read: 201, the same body as a ready repository, and the cause is logged', async () => {
    const failure = new Error('connection refused by github');
    const { github } = githubReading(() => Promise.reject(failure));
    active = await startApp(github, { agentCount: 1 });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postSigned(active.baseUrl, '/jobs', briefBody(1), buyer);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(expectedBody(1));
    expect(active.jobRepo.creates).toBe(1);
    expect(errorLog).toHaveBeenCalledWith('POST /jobs: repository read failed', failure);
  });

  it('a three-agent request goes through the same way, one job per agent', async () => {
    const failure = new Error('connection refused by github');
    const { github } = githubReading(() => Promise.reject(failure));
    active = await startApp(github, { agentCount: 3 });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postSigned(active.baseUrl, '/jobs', briefBody(3), buyer);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(expectedBody(3));
    expect(active.jobRepo.creates).toBe(3);
    expect(errorLog).toHaveBeenCalledWith('POST /jobs: repository read failed', failure);
  });

  it('the default adapter with no platform token: 201, and the log line carries the missing-token cause', async () => {
    const adapter = createGithubAdapter({ token: '', platformLogin: PLATFORM_LOGIN });
    active = await startApp(adapter, { agentCount: 1 });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postSigned(active.baseUrl, '/jobs', briefBody(1), buyer);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(expectedBody(1));
    const logged = errorLog.mock.calls.find((call) => call[0] === 'POST /jobs: repository read failed');
    expect(logged).toBeDefined();
    expect((logged![1] as Error).message).toBe('github adapter: FREEAGENTS_GITHUB_TOKEN is not configured');
  });
});

describe('(f) a ready repository opens the hire as it always did, with one read per request', () => {
  it.each(requestSizes)('201, the whole body, exactly one readRepository call (%i agent(s))', async (agentCount) => {
    const { github, reads } = githubReading(async () => readyFacts());
    active = await startApp(github, { agentCount });
    const res = await postSigned(active.baseUrl, '/jobs', briefBody(agentCount), buyer);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(expectedBody(agentCount));
    expect(reads).toEqual([{ owner: 'buyer', repo: 'brief-repo' }]);
    expect(active.jobRepo.creates).toBe(agentCount);
  });
});

describe('(g) every earlier refusal answers as before and reads nothing', () => {
  interface EarlierRefusal {
    readonly name: string;
    readonly options: StartOptions;
    readonly send: (baseUrl: string) => Promise<Response>;
    readonly status: number;
    readonly error: string;
  }

  const earlier: readonly EarlierRefusal[] = [
    {
      name: '400 body shape',
      options: { agentCount: 1 },
      send: (baseUrl) => postSigned(baseUrl, '/jobs', { agentDid: agentIdentities[0]!.did, repository: REPOSITORY }, buyer),
      status: 400,
      error:
        'body must be { agentDid, repository, brief, buyerDid? }; agentDid, repository, brief non-empty strings, buyerDid (if present) a string',
    },
    {
      name: '400 repository syntax',
      options: { agentCount: 1 },
      send: (baseUrl) =>
        postSigned(baseUrl, '/jobs', { agentDid: agentIdentities[0]!.did, repository: 'not a repository', brief: BRIEF }, buyer),
      status: 400,
      error: 'repository must be an owner/name pair like buyer/target-repo',
    },
    {
      name: '401 caller whose signature resolves to no account',
      options: { agentCount: 1 },
      send: (baseUrl) => postSigned(baseUrl, '/jobs', briefBody(1), stranger),
      status: 401,
      error: 'unknown key',
    },
    {
      name: '403 buyerDid that is not the signer',
      options: { agentCount: 1 },
      send: (baseUrl) => postSigned(baseUrl, '/jobs', { ...briefBody(1), buyerDid: stranger.did }, buyer),
      status: 403,
      error: 'buyerDid does not match the authenticated party',
    },
    {
      name: '404 unregistered agent',
      options: { agentCount: 1 },
      send: (baseUrl) =>
        postSigned(baseUrl, '/jobs', { agentDid: unregisteredAgent.did, repository: REPOSITORY, brief: BRIEF }, buyer),
      status: 404,
      error: `agent ${unregisteredAgent.did} is not registered; delegate an agent on this DID before opening a job for it`,
    },
    {
      name: '409 unlisted agent',
      options: { agentCount: 3, unlistedAgentIndex: 2 },
      send: (baseUrl) => postSigned(baseUrl, '/jobs', briefBody(3), buyer),
      status: 409,
      error: 'this agent is not taking new hires right now; its owner has stopped listing it',
    },
    {
      name: '403 buyer conduct',
      options: { agentCount: 1, conductGatedAgentIndex: 0 },
      send: (baseUrl) => postSigned(baseUrl, '/jobs', briefBody(1), buyer),
      status: 403,
      error: 'this agent requires minBuyerMerges of at least 1; your account has 0',
    },
    {
      name: '400 whitespace-only brief',
      options: { agentCount: 1 },
      send: (baseUrl) =>
        postSigned(baseUrl, '/jobs', { agentDid: agentIdentities[0]!.did, repository: REPOSITORY, brief: '   \n  ' }, buyer),
      status: 400,
      error: 'a job needs a brief: what should the agent do?',
    },
  ];

  it.each(earlier)('$name: unchanged, zero readRepository calls, zero jobs', async (refusal) => {
    // The repository would be refused if it were read, so a read that
    // happened would change the status and the sentence.
    const { github, reads } = githubReading(() => Promise.reject(new RepositoryNotAccessibleError('buyer', 'brief-repo', 404)));
    active = await startApp(github, refusal.options);
    const res = await refusal.send(active.baseUrl);
    expect(res.status).toBe(refusal.status);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: refusal.error });
    expect(reads).toEqual([]);
    expect(active.jobRepo.creates).toBe(0);
  });
});

describe('(h) invariant 2: an opened job answers GET /jobs/:jobId with the keys it always did', () => {
  it('the opened job reads back with exactly the keys it answered before the brief-time read', async () => {
    const { github } = githubReading(async () => readyFacts());
    active = await startApp(github, { agentCount: 1 });
    const created = await postSigned(active.baseUrl, '/jobs', briefBody(1), buyer);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const read = await fetch(`${active.baseUrl}/jobs/${id}`);
    expect(read.status).toBe(200);
    const body = (await read.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'agentDid',
      'brief',
      'briefHash',
      'buyerDid',
      'createdAt',
      'githubAccessNeeded',
      'id',
      'repository',
      'status',
    ]);
  });
});
