// HT1 Part B (attachments STEER): the required test set -- refused by
// magic bytes even when named .png, the size cap enforced, EXIF
// confirmed gone after upload, a stranger refused the download route,
// and an attachment never entering a credential/attestation/spec hash.
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

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

  // MSG1a (Make item 3 and 4): the upload reply carries contentType --
  // what the bytes route serves, distinct from `kind` (the detected
  // upload type) -- and the full-size download is actually served under
  // that type. A PNG upload re-encodes to JPEG, so both the reply and
  // the served bytes must say image/jpeg, and the served bytes must
  // actually start with the JPEG SOI marker.
  it('a PNG upload carries contentType image/jpeg and is served full-size as image/jpeg with bytes starting FF D8 FF', async () => {
    const jobId = await openDraft();
    const pngBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 128, b: 255 } } }).png().toBuffer();
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'sky.png',
      dataBase64: pngBytes.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as Record<string, unknown>;
    expect(uploaded.kind).toBe('image/png');
    expect(uploaded.contentType).toBe('image/jpeg');

    const download = await req('GET', `/jobs/${jobId}/attachments/${uploaded.id as string}`, undefined, operator);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('a PDF upload carries contentType application/pdf', async () => {
    const jobId = await openDraft();
    const pdfBytes = Buffer.from('%PDF-1.4\n%fixture content for contentType test\n');
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'quote2.pdf',
      dataBase64: pdfBytes.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as Record<string, unknown>;
    expect(uploaded.contentType).toBe('application/pdf');
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

  // Proof r1, defect 1: a real HEIC file (produced by macOS sips from a
  // source PNG, the exact reproduction the review used) must actually
  // upload and download, not fail with the underlying libvips text
  // leaking to the client.
  it('a real HEIC file uploads, decodes, and downloads as a re-encoded JPEG', async () => {
    const jobId = await openDraft();
    const heicBytes = readFileSync(join(here, '../fixtures/attachments/sample.heic'));
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'photo.heic',
      dataBase64: heicBytes.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as Record<string, unknown>;
    expect(uploaded.kind).toBe('image/heic');

    const download = await req('GET', `/jobs/${jobId}/attachments/${uploaded.id as string}`, undefined, operator);
    expect(download.status).toBe(200);
    const stored = Buffer.from(await download.arrayBuffer());
    const meta = await sharp(stored).metadata();
    // Re-encoded to a JPEG the ordinary pipeline can decode -- never the
    // original HEIC bytes kept verbatim.
    expect(meta.format).toBe('jpeg');
    expect(stored.equals(heicBytes)).toBe(false);

    const thumb = await req('GET', `/jobs/${jobId}/attachments/${uploaded.id as string}?thumbnail=1`, undefined, buyer);
    expect(thumb.status).toBe(200);
  });

  // Proof r1, defect 1 (the error-sanitisation half): a file that LOOKS
  // like HEIC by its magic bytes but is not decodable image data must
  // answer a clean, library-agnostic 400, never the raw libvips/
  // heic-convert failure text.
  it('a HEIC-shaped file that fails to decode answers a clean error, never raw decoder text', async () => {
    const jobId = await openDraft();
    // A well-formed ftyp box naming a HEIC brand, followed by garbage
    // that is not a real HEIF bitstream: passes detectMagicBytes,
    // fails decode.
    const fakeHeic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
      Buffer.alloc(64, 0xff),
    ]);
    const upload = await req('POST', `/jobs/${jobId}/attachments`, {
      filename: 'broken.heic',
      dataBase64: fakeHeic.toString('base64'),
    }, buyer);
    expect(upload.status).toBe(400);
    const body = (await upload.json()) as { error: string };
    expect(body.error).toBe('could not decode and re-encode the uploaded image');
    expect(body.error.toLowerCase()).not.toContain('libvips');
    expect(body.error.toLowerCase()).not.toContain('libheif');
    expect(body.error.toLowerCase()).not.toContain('plugin');
  });

  // MSG1a (Make item 2): GET /jobs/:jobId/attachments, gated by
  // requireThreadParty like its neighbours -- every attachment
  // referenced by a message in this job's thread, oldest first, never
  // an upload no message has claimed yet.
  describe('GET /jobs/:jobId/attachments: the sent-attachments list (MSG1a make item 2)', () => {
    it('lists only attachments a message references, oldest first, with messageId, contentType and a stranger refused', async () => {
      const jobId = await openDraft();
      const png1 = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer();
      const png2 = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 2, g: 2, b: 2 } } }).png().toBuffer();

      const upload1 = await req('POST', `/jobs/${jobId}/attachments`, { filename: 'first.png', dataBase64: png1.toString('base64') }, buyer);
      const uploaded1 = (await upload1.json()) as Record<string, unknown>;
      const attachment1 = String(uploaded1.id);
      const upload2 = await req('POST', `/jobs/${jobId}/attachments`, { filename: 'second.png', dataBase64: png2.toString('base64') }, buyer);
      const attachment2 = String((await upload2.json() as Record<string, unknown>).id);
      // An upload that is never attached to a message -- must never
      // appear in the list (the file the other party was never sent
      // stays invisible).
      await req('POST', `/jobs/${jobId}/attachments`, { filename: 'unsent.png', dataBase64: png1.toString('base64') }, buyer);

      const message1 = await req('POST', `/jobs/${jobId}/messages`, { body: '', attachmentIds: [attachment1] }, buyer);
      const messageId1 = String((await message1.json() as Record<string, unknown>).id);
      const message2 = await req('POST', `/jobs/${jobId}/messages`, { body: '', attachmentIds: [attachment2] }, buyer);
      const messageId2 = String((await message2.json() as Record<string, unknown>).id);

      const stranger403 = await req('GET', `/jobs/${jobId}/attachments`, undefined, stranger);
      expect(stranger403.status).toBe(403);

      const list = await req('GET', `/jobs/${jobId}/attachments`, undefined, operator);
      expect(list.status).toBe(200);
      const body = (await list.json()) as { attachments: Array<Record<string, unknown>> };
      expect(body.attachments.length).toBe(2);
      expect(body.attachments.map((a) => a.id)).toEqual([attachment1, attachment2]);
      expect(body.attachments.map((a) => a.messageId)).toEqual([messageId1, messageId2]);
      const row = body.attachments[0]!;
      expect(row.kind).toBe('image/png');
      expect(row.contentType).toBe('image/jpeg');
      expect(row.originalFilename).toBe('first.png');
      // Review r1, defect 4: sizeBytes is the REAL stored size (matching
      // the upload reply's own sizeBytes for the same attachment), never
      // a constant 0 -- "typeof number" alone stays green under a
      // mutant that hardcodes 0.
      expect(row.sizeBytes).toBe(uploaded1.sizeBytes);
      expect(row.sizeBytes).toBeGreaterThan(0);
      expect(typeof row.createdAt).toBe('string');
    });

    it('an empty thread lists no attachments, not an error', async () => {
      const jobId = await openDraft();
      const list = await req('GET', `/jobs/${jobId}/attachments`, undefined, buyer);
      expect(list.status).toBe(200);
      const body = (await list.json()) as { attachments: unknown[] };
      expect(body.attachments).toEqual([]);
    });

    // Review r1, defect 1: a throwing attachment repository (a real
    // storage outage, not a missing method) must answer 503, never a
    // silent empty list. A separate app instance, built with the same
    // fixture pattern as the suite above, but with a THROWING
    // attachmentRepo standing in for the real one.
    it('a storage failure reading the attachment list answers 503, never a silent empty list', async () => {
      const throwingOperatorRepo = new MemoryAccountRepository();
      await throwingOperatorRepo.register({ did: buyer.did, githubLogin: 'buyer-attachments-503' });
      await throwingOperatorRepo.register({ did: operator.did, githubLogin: 'operator-attachments-503' });
      const throwingAgentRepo = new MemoryAgentRepository();
      await throwingAgentRepo.create({
        did: agent.did,
        operatorDid: operator.did,
        delegation: delegationFixture(agent.did, operator.did) as never,
        name: 'scout-503',
        skills: ['triage'],
        githubLogin: 'scout-attachments-503',
      });
      const throwingJobRepo = new MemoryJobRepository();
      const throwingSessionAdapter = testSessionAdapter();
      const { github: throwingGithub } = createStagingLifecycleGithubFake();
      const throwingAttachmentRepo = {
        create: () => Promise.reject(new Error('unused')),
        findById: () => Promise.reject(new Error('unused')),
        listByJobId: () => Promise.reject(new Error('the database connection was reset')),
      };
      const throwingServer = createApp(
        throwingOperatorRepo,
        throwingAgentRepo,
        undefined,
        throwingGithub,
        throwingJobRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        throwingSessionAdapter,
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
        throwingAttachmentRepo as never,
      ).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => throwingServer.once('listening', resolve));
      const address = throwingServer.address();
      if (address === null || typeof address === 'string') throw new Error('expected a port');
      const throwingBaseUrl = `http://127.0.0.1:${address.port}`;
      try {
        const draft = await fetch(`${throwingBaseUrl}/jobs`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...signRequest(buyer, 'POST', `${throwingBaseUrl}/jobs`, {
              body: JSON.stringify({ agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
            }),
          },
          body: JSON.stringify({ agentDid: agent.did, repository: 'buyer/target-repo', brief: 'Fix the login bug' }),
        });
        const jobId = String((await draft.json() as Record<string, unknown>).id);
        const targetUri = `${throwingBaseUrl}/jobs/${jobId}/attachments`;
        const signed = signRequest(buyer, 'GET', targetUri);
        const res = await fetch(targetUri, {
          headers: { Accept: 'application/json', 'signature-input': signed['signature-input'], signature: signed.signature, 'content-digest': signed['content-digest'] },
        });
        expect(res.status).toBe(503);
      } finally {
        throwingServer.close();
      }
    });
  });
});
