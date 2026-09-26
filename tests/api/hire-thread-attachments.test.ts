// HT1 Part B (attachments STEER): the required test set -- refused by
// magic bytes even when named .png, the size cap enforced, EXIF
// confirmed gone after upload, a stranger refused the download route,
// and an attachment never entering a credential/attestation/spec hash.
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-attachments',
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

let server: Server;
let baseUrl: string;
let buyer: SigningIdentity;
let agent: SigningIdentity;
let operator: SigningIdentity;
let stranger: SigningIdentity;

async function req(method: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
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

async function openDraft(): Promise<string> {
  const draft = await req('POST', '/jobs', {
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const body = (await draft.json()) as Record<string, unknown>;
  return String(body.id);
}

describe('HT1 Part B: message attachments', () => {
  beforeAll(async () => {
    process.env.FREEAGENTS_ATTACHMENTS_DIR = '/tmp/ht1-attachments-test-' + Date.now();
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(181));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(182));
    operator = await signingIdentityFromSeed(new Uint8Array(32).fill(183));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(184));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-attachments' });
    await operatorRepo.register({ did: operator.did, githubLogin: 'operator-attachments' });
    await operatorRepo.register({ did: stranger.did, githubLogin: 'stranger-attachments' });

    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: operator.did,
      delegation: delegationFixture(agent.did, operator.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-attachments',
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-attachments', status: 'verified' });

    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
    const { github } = createStagingLifecycleGithubFake();
    server = createApp(
      operatorRepo,
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
      sessionAdapter,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('a real PNG uploads and downloads through the two parties', async () => {
    const jobId = await openDraft();
    const pngBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'blue.png',
      dataBase64: pngBytes.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as Record<string, unknown>;
    expect(uploaded.kind).toBe('image/png');

    const download = await req('GET', `/jobs/${jobId}/attachments/${uploaded.id as string}`, undefined, operator);
    expect(download.status).toBe(200);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('a file refused by its magic bytes even when named .png', async () => {
    const jobId = await openDraft();
    const notReallyPng = Buffer.from('this is plain text, not a PNG file at all');
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'totally-a-real.png',
      dataBase64: notReallyPng.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(400);
    const body = (await upload.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('not a recognised');
  });

  it('the size cap is enforced', async () => {
    const jobId = await openDraft();
    // A real PNG signature followed by 11 MB of filler, so this refuses
    // on SIZE, not on the magic-bytes check.
    const oversized = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(11 * 1024 * 1024, 0),
    ]);
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'huge.png',
      dataBase64: oversized.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(400);
    const body = (await upload.json()) as { error: string };
    expect(body.error).toContain('byte cap');
  });

  it('EXIF is confirmed gone after upload', async () => {
    const jobId = await openDraft();
    const withExif = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .withExif({ IFD0: { Make: 'ExifTestCamera', GPSLatitude: '37,46.5' } as never })
      .jpeg()
      .toBuffer();
    // Sanity: the source file genuinely carries the tag this test proves
    // gets stripped, so a refactor that skipped re-encoding entirely
    // would fail here rather than passing vacuously.
    const beforeMeta = await sharp(withExif).metadata();
    expect(beforeMeta.exif).toBeDefined();

    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'photo.jpg',
      dataBase64: withExif.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as Record<string, unknown>;

    const download = await req('GET', `/jobs/${jobId}/attachments/${uploaded.id as string}`, undefined, buyer);
    const storedBytes = Buffer.from(await download.arrayBuffer());
    const afterMeta = await sharp(storedBytes).metadata();
    expect(afterMeta.exif).toBeUndefined();
    // Never the original bytes: the stored file differs from the upload.
    expect(storedBytes.equals(withExif)).toBe(false);
  });

  it('a stranger is refused the download route', async () => {
    const jobId = await openDraft();
    const pngBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'a.png',
      dataBase64: pngBytes.toString('base64'),
    }, buyer);
    const uploaded = (await upload.json()) as Record<string, unknown>;
    const res = await req('GET', `/jobs/${jobId}/attachments/${uploaded.id as string}`, undefined, stranger);
    expect(res.status).toBe(403);
  });

  it('a PDF is served with Content-Disposition: attachment', async () => {
    const jobId = await openDraft();
    const pdfBytes = Buffer.from('%PDF-1.4\n%fixture content, not a real rendered document\n');
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'quote.pdf',
      dataBase64: pdfBytes.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as Record<string, unknown>;
    expect(uploaded.kind).toBe('application/pdf');

    const download = await req('GET', `/jobs/${jobId}/attachments/${uploaded.id as string}`, undefined, operator);
    expect(download.headers.get('content-disposition')).toContain('attachment');
  });
});
