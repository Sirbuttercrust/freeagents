// FIX-SW4f (bugs.md SW4-05): one account cannot fill the server's disk with
// uploads it never sends. Drives the real createApp over a listening server
// on memory repositories the test can read. Time moves with a faked Date
// only (the clock the quota, the age check and the sweep read); timers,
// sockets and fetch keep running on real time.
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryAttachmentRepository,
  MemoryJobRepository,
  MemoryMessageRepository,
} from '../../src/adapters/storage/memory.js';
import { writeAttachmentFile } from '../../src/adapters/attachments/storage.js';
import { createMessage, ThreadReadOnlyError } from '../../src/domain/message.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const T0 = new Date('2026-09-30T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const JOB_SENTENCE = 'Too many files were uploaded to this conversation without being sent. Send one of them, or try again later.';
const ACCOUNT_SENTENCE = 'Too many files were uploaded by this account without being sent. Send one of them, or try again later.';

let attachmentsDir: string;
let envBefore: string | undefined;

beforeAll(() => {
  envBefore = process.env.FREEAGENTS_ATTACHMENTS_DIR;
  attachmentsDir = mkdtempSync(join(tmpdir(), 'fix-sw4f-'));
  process.env.FREEAGENTS_ATTACHMENTS_DIR = attachmentsDir;
});

afterAll(() => {
  if (envBefore === undefined) delete process.env.FREEAGENTS_ATTACHMENTS_DIR;
  else process.env.FREEAGENTS_ATTACHMENTS_DIR = envBefore;
  rmSync(attachmentsDir, { recursive: true, force: true });
});

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-unsent-uploads',
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

interface World {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly operator: SigningIdentity;
  readonly stranger: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly jobs: MemoryJobRepository;
  readonly messages: MemoryMessageRepository;
  readonly attachments: MemoryAttachmentRepository;
}

let world: World;

async function startWorld(): Promise<World> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(232));
  const operator = await signingIdentityFromSeed(new Uint8Array(32).fill(233));
  const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(234));
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: buyer.did, githubLogin: 'buyer-unsent' });
  await accounts.register({ did: operator.did, githubLogin: 'operator-unsent' });
  await accounts.register({ did: stranger.did, githubLogin: 'stranger-unsent' });
  const agents = new MemoryAgentRepository();
  await agents.create({
    did: agent.did,
    operatorDid: operator.did,
    delegation: delegationFixture(agent.did, operator.did) as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-unsent',
  });
  await agents.updateGithubBinding(agent.did, { handle: 'scout-unsent', status: 'verified' });
  const jobs = new MemoryJobRepository();
  const messages = new MemoryMessageRepository();
  const attachments = new MemoryAttachmentRepository();
  const { github } = createStagingLifecycleGithubFake();
  const server = createApp(
    accounts, agents, undefined, github, jobs,
    undefined, undefined, undefined, undefined, undefined, undefined,
    testSessionAdapter(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    messages,
    undefined, undefined,
    attachments,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, buyer, operator, stranger, agent, jobs, messages, attachments };
}

beforeEach(async () => {
  rmSync(attachmentsDir, { recursive: true, force: true });
  mkdirSync(attachmentsDir, { recursive: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  world = await startWorld();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  world.server.closeAllConnections();
  await new Promise<void>((resolve) => world.server.close(() => resolve()));
});

async function req(method: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const targetUri = `${world.baseUrl}${path}`;
  const signed = signRequest(identity, method, targetUri, { body: bodyText });
  return fetch(targetUri, {
    method,
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    ...(body === undefined ? {} : { body: bodyText }),
  });
}

async function openDraft(identity: SigningIdentity = world.buyer): Promise<string> {
  const draft = await req('POST', '/jobs', { agentDid: world.agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, identity);
  expect(draft.status).toBe(201);
  return String(((await draft.json()) as Record<string, unknown>).id);
}

let counter = 0;
function pdf(): string {
  counter += 1;
  return Buffer.from(`%PDF-1.4\nunsent-upload-${counter}\n`, 'utf8').toString('base64');
}

async function png(): Promise<string> {
  counter += 1;
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: counter % 255, g: 10, b: 200 } } }).png().toBuffer();
  return bytes.toString('base64');
}

function upload(jobId: string, identity: SigningIdentity = world.buyer, dataBase64?: string): Promise<Response> {
  return req('POST', `/jobs/${jobId}/attachments`, { filename: 'file.pdf', dataBase64: dataBase64 ?? pdf() }, identity);
}

async function uploadOk(jobId: string, identity: SigningIdentity = world.buyer, dataBase64?: string): Promise<string> {
  const res = await upload(jobId, identity, dataBase64);
  expect(res.status).toBe(201);
  return String(((await res.json()) as Record<string, unknown>).id);
}

function filesOnDisk(): string[] {
  return readdirSync(attachmentsDir).sort();
}

describe('FIX-SW4f: a caller cannot fill the disk with uploads it never sends', () => {
  it('(a) ten unsent uploads on one job are accepted; the eleventh is refused with 429 and adds no file and no row', async () => {
    const jobId = await openDraft();
    for (let i = 0; i < 10; i += 1) await uploadOk(jobId);
    const eleventh = await upload(jobId);
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get('retry-after')).toBe('60');
    expect(await eleventh.json()).toEqual({ error: JOB_SENTENCE });
    expect(filesOnDisk()).toHaveLength(10);
    expect(await world.attachments.listByJobId(jobId)).toHaveLength(10);
  });

  it('(b) the other party on the same job still uploads: the cap is per caller', async () => {
    const jobId = await openDraft();
    for (let i = 0; i < 10; i += 1) await uploadOk(jobId);
    expect((await upload(jobId, world.buyer)).status).toBe(429);
    expect((await upload(jobId, world.operator)).status).toBe(201);
  });

  it('(c) twenty unsent uploads across three jobs refuse a fourth job with the account sentence', async () => {
    const jobs = [await openDraft(), await openDraft(), await openDraft()];
    for (const [jobId, n] of [[jobs[0]!, 7], [jobs[1]!, 7], [jobs[2]!, 6]] as const) {
      for (let i = 0; i < n; i += 1) await uploadOk(jobId);
    }
    const fourth = await openDraft();
    const refused = await upload(fourth);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await refused.json()).toEqual({ error: ACCOUNT_SENTENCE });
    expect(filesOnDisk()).toHaveLength(20);
    expect(await world.attachments.listByJobId(fourth)).toEqual([]);
  });

  it('(d) sending an upload in a message frees a place, and the sent upload\'s row carries that message\'s id', async () => {
    const jobId = await openDraft();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(await uploadOk(jobId));
    expect((await upload(jobId)).status).toBe(429);
    const sent = await req('POST', `/jobs/${jobId}/messages`, { body: 'here it is', attachmentIds: [ids[0]] }, world.buyer);
    expect(sent.status).toBe(201);
    const message = (await sent.json()) as { id: string };
    expect((await upload(jobId)).status).toBe(201);
    expect((await world.attachments.findById(ids[0]!))?.messageId).toBe(message.id);
    expect((await world.attachments.findById(ids[1]!))?.messageId ?? null).toBeNull();
  });

  it('(e) an upload older than an hour stops counting against the caller', async () => {
    // The sweep is silenced so this pins the count itself; (g) pins the sweep.
    vi.spyOn(world.attachments, 'listUnsentOlderThan').mockResolvedValue([]);
    const counted = vi.spyOn(world.attachments, 'listUnsentByUploader');
    const jobId = await openDraft();
    for (let i = 0; i < 10; i += 1) await uploadOk(jobId);
    expect((await upload(jobId)).status).toBe(429);
    vi.setSystemTime(new Date(T0.getTime() + HOUR_MS + 1000));
    expect((await upload(jobId)).status).toBe(201);
    // The route asks the repository only for uploads younger than an hour.
    expect(counted).toHaveBeenLastCalledWith(world.buyer.did, new Date(T0.getTime() + 1000));
  });

  it('(f) a message naming an upload older than an hour answers 400 and stores no message', async () => {
    const jobId = await openDraft();
    const id = await uploadOk(jobId);
    const before = await world.messages.listByJobId(jobId);
    vi.setSystemTime(new Date(T0.getTime() + HOUR_MS + 1000));
    const res = await req('POST', `/jobs/${jobId}/messages`, { body: 'too late', attachmentIds: [id] }, world.buyer);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `${id} expired before it was sent; upload the file again.` });
    expect(await world.messages.listByJobId(jobId)).toEqual(before);
  });

  it('(g) the sweep removes an old unsent upload with both files, keeps what a message carries, and survives a missing file', async () => {
    const jobId = await openDraft();
    // Oldest first: a PDF whose file is already gone, then an unsent image
    // (full and thumbnail), then a PDF a message carries through the route.
    const missingFileId = await uploadOk(jobId);
    rmSync((await world.attachments.findById(missingFileId))!.path);
    const imageId = await uploadOk(jobId, world.buyer, await png());
    const image = (await world.attachments.findById(imageId))!;
    expect(image.thumbnailPath).not.toBeNull();
    const sentId = await uploadOk(jobId);
    const sentMessage = await req('POST', `/jobs/${jobId}/messages`, { body: 'sent', attachmentIds: [sentId] }, world.buyer);
    expect(sentMessage.status).toBe(201);
    // A row stored the old way: null messageId, and a message that names it.
    const oldWayPath = await writeAttachmentFile(attachmentsDir, 'old-way-file', Buffer.from('%PDF-1.4\nold way\n'));
    await world.attachments.create({
      id: 'old-way', jobId, uploaderDid: world.buyer.did, kind: 'application/pdf', originalFilename: 'old.pdf',
      sizeBytes: 16, path: oldWayPath, thumbnailPath: null, messageId: null, createdAt: T0,
    });
    const oldWayMessage = await world.messages.create(createMessage({
      id: 'm-old-way', jobId, authorDid: world.buyer.did, authorParty: 'buyer', authorKind: 'buyer', body: 'old way',
      existingMessageIds: new Set<string>(), attachments: [{ attachmentId: 'old-way' }],
    }, T0));

    vi.setSystemTime(new Date(T0.getTime() + HOUR_MS + 1000));
    const freshId = await uploadOk(jobId);

    expect(await world.attachments.findById(missingFileId)).toBeNull();
    expect(await world.attachments.findById(imageId)).toBeNull();
    expect(existsSync(image.path)).toBe(false);
    expect(existsSync(image.thumbnailPath!)).toBe(false);
    const sentRow = (await world.attachments.findById(sentId))!;
    expect(sentRow.messageId).toBe(((await sentMessage.json()) as { id: string }).id);
    const oldWayRow = (await world.attachments.findById('old-way'))!;
    expect(oldWayRow.messageId).toBe(oldWayMessage.id);
    expect(filesOnDisk()).toEqual([sentId, 'old-way-file', freshId].sort());
  });

  it('(g2) a removal that fails on one row is logged and the sweep goes on to the next row', async () => {
    const jobId = await openDraft();
    const stuckId = await uploadOk(jobId);
    const goneId = await uploadOk(jobId);
    const stuck = (await world.attachments.findById(stuckId))!;
    // A directory where the file should be: removing it fails with something other than ENOENT.
    rmSync(stuck.path);
    mkdirSync(stuck.path);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.setSystemTime(new Date(T0.getTime() + HOUR_MS + 1000));
    await uploadOk(jobId);
    expect(await world.attachments.findById(stuckId)).not.toBeNull();
    expect(await world.attachments.findById(goneId)).toBeNull();
    expect(errors.mock.calls.some((call) => String(call[0]).includes(stuckId))).toBe(true);
  });

  it('(h) a stranger gets 403 and a finished job\'s thread gets 409, never 429, with the caller\'s quota full', async () => {
    const jobId = await openDraft();
    for (let i = 0; i < 10; i += 1) await uploadOk(jobId);
    // The stranger's own quota is full across three jobs of its own.
    const own = [await openDraft(world.stranger), await openDraft(world.stranger), await openDraft(world.stranger)];
    for (const [ownId, n] of [[own[0]!, 7], [own[1]!, 7], [own[2]!, 6]] as const) {
      for (let i = 0; i < n; i += 1) await uploadOk(ownId, world.stranger);
    }
    const strangerRes = await upload(jobId, world.stranger);
    expect(strangerRes.status).toBe(403);
    expect(strangerRes.headers.get('retry-after')).toBeNull();
    const strangerBody = (await strangerRes.json()) as Record<string, unknown>;
    expect(Object.keys(strangerBody)).toEqual(['error']);
    expect(strangerBody.error).not.toBe(JOB_SENTENCE);
    expect(strangerBody.error).not.toBe(ACCOUNT_SENTENCE);

    const job = (await world.jobs.findById(jobId))!;
    await world.jobs.update({ ...job, status: 'withdrawn' });
    const readOnly = await upload(jobId);
    expect(readOnly.status).toBe(409);
    expect(await readOnly.json()).toEqual({ error: new ThreadReadOnlyError(jobId).message });
  });

  it('(i) two uploads five minutes apart run the sweep once, and one eleven minutes after the first runs it again', async () => {
    const listUnsent = vi.spyOn(world.attachments, 'listUnsentOlderThan');
    const jobId = await openDraft();
    await uploadOk(jobId);
    expect(listUnsent).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(T0.getTime() + 5 * MINUTE_MS));
    await uploadOk(jobId);
    expect(listUnsent).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(T0.getTime() + 11 * MINUTE_MS));
    await uploadOk(jobId);
    expect(listUnsent).toHaveBeenCalledTimes(2);
  });

  it('(j) a row write that fails after the files were written answers 503 and leaves no file', async () => {
    const jobId = await openDraft();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(world.attachments, 'create').mockRejectedValueOnce(new Error('database is down'));
    const res = await upload(jobId, world.buyer, await png());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage unavailable' });
    expect(filesOnDisk()).toEqual([]);
  });

  it('(k) a markSent failure after the message is stored is logged and the message still answers 201', async () => {
    const jobId = await openDraft();
    const id = await uploadOk(jobId);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(world.attachments, 'markSent').mockRejectedValueOnce(new Error('database is down'));
    const res = await req('POST', `/jobs/${jobId}/messages`, { body: 'sent', attachmentIds: [id] }, world.buyer);
    expect(res.status).toBe(201);
    expect((await world.messages.listByJobId(jobId)).map((m) => m.body)).toEqual(['sent']);
    expect(errors.mock.calls.some((call) => String(call[0]).includes('markSent'))).toBe(true);
  });

  // The uploads below are fired together. A count that is read and then acted
  // on after the re-encode and the writes lets every request see the same
  // count, so these pin that the count and the admission are one step per
  // caller. The images are noise so the re-encode takes real time.
  async function noisePng(): Promise<string> {
    const raw = randomBytes(700 * 700 * 3);
    return (await sharp(raw, { raw: { width: 700, height: 700, channels: 3 } }).png().toBuffer()).toString('base64');
  }

  it('(l) thirty uploads fired together on one job admit exactly ten, refuse twenty, and leave ten rows with their files', async () => {
    const jobId = await openDraft();
    const image = await noisePng();
    const answers = await Promise.all(Array.from({ length: 30 }, () => upload(jobId, world.buyer, image)));
    const bodies = await Promise.all(answers.map(async (res) => ({ status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json()) as Record<string, unknown> })));
    const refused = bodies.filter((answer) => answer.status === 429);
    expect(bodies.filter((answer) => answer.status === 201)).toHaveLength(10);
    expect(refused).toHaveLength(20);
    for (const answer of refused) expect(answer).toEqual({ status: 429, retryAfter: '60', body: { error: JOB_SENTENCE } });
    expect(await world.attachments.listByJobId(jobId)).toHaveLength(10);
    expect(filesOnDisk()).toHaveLength(20);
  });

  it('(m) thirty-six uploads fired together across three jobs admit exactly twenty, and the account cap refuses the rest', async () => {
    const jobs = [await openDraft(), await openDraft(), await openDraft()];
    const image = await noisePng();
    const answers = await Promise.all(Array.from({ length: 36 }, (_, i) => upload(jobs[i % 3]!, world.buyer, image)));
    const statuses = answers.map((res) => res.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(20);
    expect(statuses.filter((status) => status === 429)).toHaveLength(16);
    const rows = (await Promise.all(jobs.map((jobId) => world.attachments.listByJobId(jobId)))).flat();
    expect(rows).toHaveLength(20);
    expect(filesOnDisk()).toHaveLength(40);
  });

  it('(n) an upload whose count was read before another upload stored its row does not use that stale count', async () => {
    const jobId = await openDraft();
    for (let i = 0; i < 9; i += 1) await uploadOk(jobId);
    const original = world.attachments.listUnsentByUploader.bind(world.attachments);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(world.attachments, 'listUnsentByUploader').mockImplementationOnce(async (did, since) => {
      const snapshot = await original(did, since);
      await gate;
      return snapshot;
    });
    const slow = upload(jobId);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect((await upload(jobId)).status).toBe(201);
    release();
    const refused = await slow;
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: JOB_SENTENCE });
    expect(await world.attachments.listByJobId(jobId)).toHaveLength(10);
  });
});
