// MSG1b: one hire-conversation world for tests/web/messages.test.ts (and
// the screenshot run that feeds the PR). A real app on memory repositories,
// three signed-in people (the hirer, the agent's owner, a stranger), and
// five hires in different states. Every message a party writes goes
// through the real routes with that party's own session; only the rows no
// party can write through a route (the platform's system rows, and one
// row the agent's own key sent by itself) are stored directly.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { createApp } from '../../src/api/app.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import type { Session } from '../../src/adapters/identity/session.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryAttachmentRepository,
  MemoryCredentialRepository,
  MemoryJobRepository,
  MemoryMessageRepository,
  MemoryThreadReadStateRepository,
} from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { createJob, type Job } from '../../src/domain/job.js';
import { createMessage, createSystemMessage, type Message, type SystemEvent } from '../../src/domain/message.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSession } from './session-fixtures.js';

export const BUYER_LOGIN = 'msg-buyer';
export const OWNER_LOGIN = 'msg-owner';
export const STRANGER_LOGIN = 'msg-stranger';
export const BUYER_DID = 'did:abt:zMsgBuyerAccount';
export const OWNER_DID = 'did:abt:zMsgOwnerAccount';
export const STRANGER_DID = 'did:abt:zMsgStrangerAccount';
export const AGENT_DID = 'did:abt:zMsgAtlasAgent';
export const AGENT_NAME = 'msg-atlas';
export const IDENTITIES = [BUYER_DID, OWNER_DID, STRANGER_DID, AGENT_DID];

// The hires, by state.
export const OPEN = 'msg-job-open'; // proposed, mid-negotiation: the full conversation
export const AGREED = 'msg-job-agreed'; // proposed, every line and the price signed by both
export const STAGED = 'msg-job-staged'; // staged, waiting on the hirer's review
export const SUBMITTED = 'msg-job-submitted'; // the pull request is open
export const DONE = 'msg-job-done'; // completed: read only, every system event
export const BRIEF = 'Move Postgres 12 to 16 on a new host.\nIt is about 40 GB, and one Django app writes to it.';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface ThreadIds {
  readonly thanks: string;
  readonly question: string;
  readonly quote1: string;
  readonly push: string;
  readonly counter: string;
  readonly quote2: string;
  readonly auto: string;
  readonly imageFile: string;
  readonly image: string;
  readonly pdfFile: string;
  readonly pdf: string;
  readonly night: string;
  readonly doneThanks: string;
}

export interface World {
  readonly server: Server;
  readonly baseUrl: string;
  readonly accounts: MemoryAccountRepository;
  readonly agents: MemoryAgentRepository;
  readonly jobs: MemoryJobRepository;
  readonly messages: MemoryMessageRepository;
  readonly readStates: MemoryThreadReadStateRepository;
  readonly attachments: MemoryAttachmentRepository;
  readonly buyer: Session;
  readonly owner: Session;
  readonly stranger: Session;
  // Message and file ids in the fixture's threads, by what they are.
  readonly ids: ThreadIds;
  readonly png: Buffer;
  readonly pdf: Buffer;
  close(): Promise<void>;
}

function delegation(did: string): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:msg-${did}`,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: OWNER_DID,
    issuanceDate: '2026-09-01T00:00:00Z',
    credentialSubject: { id: did },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-01T00:00:00Z',
      verificationMethod: `${OWNER_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zMsgFixtureNotVerifiedHere',
    },
  };
}

function receipt(jobId: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `https://freeagents.dev/v1/credentials/${jobId}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: 'did:abt:platform',
    validFrom: new Date(Date.now() - 9 * DAY).toISOString(),
    credentialSubject: {
      id: AGENT_DID,
      hire: {
        brief: 'sha256:msg-brief',
        repository: 'buyer/msg-repo',
        pullRequest: 'https://github.com/buyer/msg-repo/pull/7',
        mergedAt: new Date(Date.now() - 9 * DAY).toISOString(),
        mergeCommit: 'msgmergecommit',
        signedBy: `${AGENT_DID}#key-1`,
        buyer: BUYER_DID,
        additions: 120,
        deletions: 40,
        filesChanged: 7,
      },
    },
    proof: { type: 'Ed25519Signature2020', proofValue: 'zMsgProof' },
  } as VerifiableCredential;
}

const CRITERIA_OPEN = [
  { text: 'Postgres 16 runs on the new host', proposedBy: 'agent' as const, acceptedByBuyer: false, acceptedByAgent: true },
  { text: 'The app is down for 10 minutes or less', proposedBy: 'agent' as const, acceptedByBuyer: false, acceptedByAgent: true },
];
const CRITERIA_SIGNED = CRITERIA_OPEN.map((c) => ({ ...c, acceptedByBuyer: true, acceptedByAgent: true }));

function job(id: string, createdAt: Date, overrides: Partial<Job>): Job {
  const base = createJob({ id, buyerDid: BUYER_DID, agentDid: AGENT_DID, repository: 'buyer/msg-repo', brief: BRIEF }, createdAt);
  return { ...base, ...overrides };
}

export async function buildMessagesWorld(): Promise<World> {
  const attachmentsDir = mkdtempSync(join(tmpdir(), 'fa-msg1b-attachments-'));
  const previousDir = process.env.FREEAGENTS_ATTACHMENTS_DIR;
  process.env.FREEAGENTS_ATTACHMENTS_DIR = attachmentsDir;

  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: BUYER_DID, githubLogin: BUYER_LOGIN });
  await accounts.register({ did: OWNER_DID, githubLogin: OWNER_LOGIN });
  await accounts.register({ did: STRANGER_DID, githubLogin: STRANGER_LOGIN });

  const agents = new MemoryAgentRepository();
  await agents.create({ did: AGENT_DID, operatorDid: OWNER_DID, delegation: delegation(AGENT_DID), name: AGENT_NAME, skills: ['postgres'], githubLogin: null });

  const now = Date.now();
  const recent = new Date(now - 2 * HOUR);
  const jobs = new MemoryJobRepository();
  await jobs.create(job(OPEN, new Date(now - 3 * HOUR), {
    status: 'proposed', criteria: CRITERIA_OPEN, priceUsd: '1200.00', rail: 'abt', depositPercent: 25, deliveryWindowDays: 5,
  }));
  await jobs.create(job(AGREED, new Date(now - 5 * HOUR), {
    brief: 'Add error alerts to the Django app.', status: 'proposed', criteria: CRITERIA_SIGNED, priceUsd: '400.00', rail: 'abt',
    depositPercent: 25, deliveryWindowDays: 3, priceAcceptedByBuyer: true, priceAcceptedByAgent: true,
  }));
  await jobs.create(job(STAGED, new Date(now - 6 * HOUR), {
    brief: 'Fix the CSV export timeouts.', status: 'staged', criteria: CRITERIA_SIGNED, priceUsd: '600.00', rail: 'abt',
    priceAcceptedByBuyer: true, priceAcceptedByAgent: true, confirmedAt: recent, confirmedSpecHash: 'sha256:msg-staged-spec',
    stagedAt: recent, stagedCommit: 'msgstagedcommit',
  }));
  await jobs.create(job(SUBMITTED, new Date(now - 7 * HOUR), {
    brief: 'Speed up the search page.', status: 'submitted', criteria: CRITERIA_SIGNED, priceUsd: '800.00', rail: 'abt',
    priceAcceptedByBuyer: true, priceAcceptedByAgent: true, confirmedAt: recent, confirmedSpecHash: 'sha256:msg-submitted-spec',
    stagedAt: recent, stagedCommit: 'msgsubmittedcommit', pullRequestUrl: 'https://github.com/buyer/msg-repo/pull/6', submittedAt: recent,
  }));
  const doneAt = new Date(now - 9 * DAY);
  await jobs.create(job(DONE, new Date(now - 12 * DAY), {
    brief: 'Upgrade Django to 5.1.', status: 'completed', criteria: CRITERIA_SIGNED, priceUsd: '1200.00', rail: 'abt',
    priceAcceptedByBuyer: true, priceAcceptedByAgent: true, confirmedAt: new Date(now - 11 * DAY), confirmedSpecHash: 'sha256:msg-done-spec',
    stagedAt: new Date(now - 10 * DAY), stagedCommit: 'msgdonecommit', pullRequestUrl: 'https://github.com/buyer/msg-repo/pull/7',
    submittedAt: new Date(now - 10 * DAY), mergeCommit: 'msgmergecommit', mergedAt: doneAt,
  }));
  const credentials = new MemoryCredentialRepository();
  await credentials.save({ completedJobId: DONE, subjectDid: AGENT_DID, document: receipt(DONE), repositoryPublic: true });

  const messages = new MemoryMessageRepository();
  const readStates = new MemoryThreadReadStateRepository();
  const attachments = new MemoryAttachmentRepository();

  // One session adapter; each person signs in through the same fake GitHub
  // round trip with their own login.
  let nextLogin = BUYER_LOGIN;
  const logins = [BUYER_LOGIN, OWNER_LOGIN, STRANGER_LOGIN];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    fakeGitHubFetch({ login: nextLogin, id: 7100 + logins.indexOf(nextLogin) })(input, init)) as typeof fetch;
  const session = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl });

  const server = createApp(
    accounts, agents, undefined, undefined, jobs, undefined, undefined, credentials,
    // Generous limits, never a raised default: these suites drive many
    // real page loads against one app.
    { verify: 10_000, read: 10_000, write: 10_000, upstream: 10_000 },
    undefined, undefined, session,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    messages, readStates, undefined, attachments,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  nextLogin = BUYER_LOGIN;
  const buyer = await mintSession(session);
  nextLogin = OWNER_LOGIN;
  const owner = await mintSession(session);
  nextLogin = STRANGER_LOGIN;
  const stranger = await mintSession(session);

  const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 40, g: 90, b: 200 } } }).png().toBuffer();
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

  const call = async (who: Session, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await asPartyAt(baseUrl, who, method, path, body);
    if (res.status >= 300) throw new Error(`fixture ${method} ${path} answered ${res.status}: ${await res.text()}`);
    return res.status === 204 ? {} : ((await res.json()) as Record<string, unknown>);
  };
  const post = async (who: Session, jobId: string, body: string, extra: Record<string, unknown> = {}): Promise<string> =>
    String((await call(who, 'POST', `/jobs/${jobId}/messages`, { body, ...extra })).id);
  let systemSeq = 0;
  const system = async (jobId: string, event: SystemEvent, at: Date, body = ''): Promise<string> => {
    systemSeq += 1;
    const row = createSystemMessage({ id: `sys-${jobId}-${event.type}-${systemSeq}`, jobId, body, systemEvent: event }, at);
    await messages.create(row);
    return row.id;
  };
  const direct = async (jobId: string, input: Partial<Message> & { id: string; body: string; authorParty: 'buyer' | 'agent'; authorKind: Message['authorKind']; authorDid: string }, at: Date): Promise<string> => {
    const existing = await messages.listByJobId(jobId);
    const row = createMessage({
      id: input.id, jobId, authorDid: input.authorDid, authorParty: input.authorParty, authorKind: input.authorKind, body: input.body,
      existingMessageIds: new Set(existing.map((m) => m.id)),
    }, at);
    await messages.create({ ...row, reactions: input.reactions ?? row.reactions });
    return row.id;
  };

  // THE OPEN HIRE, told in order.
  const thanks = await post(owner, OPEN, 'Thanks, this is a clear brief.');
  const question = await post(owner, OPEN, 'Any extensions besides the defaults? My checklist is at https://example.com/checklist. javascript:alert(1) is only words.');
  const quote1 = await system(OPEN, { type: 'quote_sent', priceUsd: '1400.00', rail: 'abt', deliveryWindowDays: 5, criteriaCount: 2 }, new Date());
  const push = await post(buyer, OPEN, 'Could you do $1,100? I can make the staging snapshot myself.');
  const counter = await post(owner, OPEN, 'If you make the snapshot, $1,200 works.', { replyToId: push });
  await call(buyer, 'POST', `/jobs/${OPEN}/messages/${counter}/reactions`, { emoji: '\uD83E\uDD1D' });
  await call(owner, 'POST', `/jobs/${OPEN}/messages/${counter}/reactions`, { emoji: '\uD83D\uDC4D' });
  const quote2 = await system(OPEN, { type: 'quote_sent', priceUsd: '1200.00', rail: 'abt', deliveryWindowDays: 5, criteriaCount: 2 }, new Date());
  const auto = await direct(OPEN, { id: 'm-msg-auto', body: 'I can start the copy as soon as the deposit lands.', authorParty: 'agent', authorKind: 'agent-autonomous', authorDid: AGENT_DID }, new Date());
  const imageFile = String((await call(owner, 'POST', `/jobs/${OPEN}/attachments`, { filename: 'staging-check.png', dataBase64: png.toString('base64') })).id);
  const image = await post(owner, OPEN, '', { attachmentIds: [imageFile] });
  const pdfFile = String((await call(owner, 'POST', `/jobs/${OPEN}/attachments`, { filename: 'db-access-policy.pdf', dataBase64: pdf.toString('base64') })).id);
  const pdfMessage = await post(owner, OPEN, 'Our access policy, for the cutover night.', { attachmentIds: [pdfFile] });
  const night = await post(buyer, OPEN, 'Wednesday after 10 PM Eastern.');
  await call(buyer, 'PATCH', `/jobs/${OPEN}/messages/${night}`, { body: 'Thursday after 10 PM Eastern.' });

  // THE FINISHED HIRE: every event the platform writes, days ago.
  const at = (d: number, h = 0): Date => new Date(now - d * DAY + h * HOUR);
  await direct(DONE, { id: 'm-msg-done-start', body: 'Starting the cutover.', authorParty: 'agent', authorKind: 'owner', authorDid: OWNER_DID }, at(11));
  await system(DONE, { type: 'deposit_paid', leg: 'deposit', amountUsd: '300.00', rail: 'abt' }, at(11, 1));
  await system(DONE, { type: 'staged' }, at(10));
  await system(DONE, { type: 'pr_opened', pullRequestUrl: 'https://github.com/buyer/msg-repo/pull/7' }, at(10, 1));
  await system(DONE, { type: 'remainder_paid', leg: 'remainder', amountUsd: '900.00', rail: 'abt' }, at(9));
  await system(DONE, { type: 'completed', mergeCommit: 'msgmergecommit' }, at(9, 1));
  const doneThanks = await direct(DONE, {
    id: 'm-msg-done-thanks', body: 'Thanks. Good working with you.', authorParty: 'buyer', authorKind: 'buyer', authorDid: BUYER_DID,
    reactions: { buyer: null, agent: '\u2764\uFE0F' },
  }, at(9, 2));

  const ids: ThreadIds = { thanks, question, quote1, push, counter, quote2, auto, imageFile, image, pdfFile, pdf: pdfMessage, night, doneThanks };

  return {
    server, baseUrl, accounts, agents, jobs, messages, readStates, attachments, buyer, owner, stranger, ids, png, pdf,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousDir === undefined) delete process.env.FREEAGENTS_ATTACHMENTS_DIR;
      else process.env.FREEAGENTS_ATTACHMENTS_DIR = previousDir;
      rmSync(attachmentsDir, { recursive: true, force: true });
    },
  };
}

// The same round trip a person's page makes, for a test that acts as the
// other party through the API.
export async function asParty(world: World, who: Session, method: string, path: string, body?: unknown): Promise<Response> {
  return asPartyAt(world.baseUrl, who, method, path, body);
}

function asPartyAt(baseUrl: string, who: Session, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { Accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, init);
}
