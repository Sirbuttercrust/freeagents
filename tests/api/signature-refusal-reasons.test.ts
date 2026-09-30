// SW1-08: a refused request signature says which check failed, and
// GET /capabilities says how a request is signed before one is sent.
//
// Every refusal below goes through a real route over HTTP and asserts the
// status and the WHOLE JSON body with toEqual, so a change to any sentence
// fails here. The sentences are written out in full on purpose: a test that
// rebuilt them from the source constants would pass when the wording drifted.
//
// This file pins how a refusal is reported. It does not touch how a signature
// is verified; tests/api/did-signature.test.ts and
// tests/api/signature-replay.test.ts still pin every verdict.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
} from '../../src/adapters/storage/memory.js';
import {
  REQUEST_SIGNATURE_COMPONENTS,
  SIGNATURE_MAX_AGE_SECONDS,
  verifyWithReason,
} from '../../src/adapters/identity/http-signature.js';
import type { SignatureSpendStorage } from '../../src/adapters/identity/signature-spend-storage-types.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { alwaysSettledGate } from '../helpers/settlement-fixtures.js';

let registered: SigningIdentity;
let unregistered: SigningIdentity;
let server: Server;
let baseUrl: string;

// createApp takes the spend store as its 21st positional argument.
function listenWith(spend: SignatureSpendStorage | undefined, accounts: MemoryAccountRepository): Server {
  const { github } = createStagingLifecycleGithubFake();
  const u = undefined;
  return createApp(
    accounts, new MemoryAgentRepository(), u, github, new MemoryJobRepository(), u, u, u, u, u, u, u, u,
    alwaysSettledGate(), u, u, u, u, u, u, spend,
  ).listen(0, '127.0.0.1');
}

async function listening(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.once('listening', resolve));
  const address = s.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return `http://127.0.0.1:${address.port}`;
}

// The route every case below signs for: request-changes mounts didSignature,
// which answers a bad signature before it looks at the job at all.
const CHANGES_PATH = '/jobs/job-refusal-reasons/request-changes';
const BODY = '{}';

type Headers = Record<string, string>;

function signed(identity: SigningIdentity, path: string, opts: Parameters<typeof signRequest>[3] = {}): Headers {
  const s = signRequest(identity, 'POST', `${baseUrl}${path}`, { body: BODY, ...opts });
  return { 'signature-input': s['signature-input'], signature: s.signature, 'content-digest': s['content-digest'] };
}

async function send(path: string, headers: Headers, body = BODY, origin = baseUrl): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: res.status, body: await res.json() };
}

const refused = (sentence: string) => ({ status: 401, body: { error: `invalid signature: ${sentence}` } });

beforeAll(async () => {
  registered = await signingIdentityFromSeed(new Uint8Array(32).fill(71));
  unregistered = await signingIdentityFromSeed(new Uint8Array(32).fill(72));
  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: registered.did, githubLogin: 'refusal-reasons-buyer' });
  server = listenWith(undefined, accounts);
  baseUrl = await listening(server);
});

afterAll(() => {
  server.close();
});

describe('SW1-08 (a): each check that refuses a signature names itself, from the didSignature route', () => {
  it('answers "send both headers" when Signature is missing', async () => {
    const h = signed(registered, CHANGES_PATH);
    expect(await send(CHANGES_PATH, { 'signature-input': h['signature-input'] ?? '', 'content-digest': h['content-digest'] ?? '' })).toEqual(
      refused('send both the Signature-Input and Signature headers'),
    );
  });

  it('answers "send both headers" when Signature-Input is missing', async () => {
    const h = signed(registered, CHANGES_PATH);
    expect(await send(CHANGES_PATH, { signature: h.signature ?? '', 'content-digest': h['content-digest'] ?? '' })).toEqual(
      refused('send both the Signature-Input and Signature headers'),
    );
  });

  const SHAPE =
    'Signature-Input is not readable; write it as sig1=("@method" "@target-uri" "content-digest");keyid="<your DID>#<key id>";alg="ed25519";created=<Unix seconds>';

  it('answers with the Signature-Input shape when it is not a labelled list', async () => {
    const h = signed(registered, CHANGES_PATH);
    expect(await send(CHANGES_PATH, { ...h, 'signature-input': 'not a signature input' })).toEqual(refused(SHAPE));
  });

  it('answers with the Signature-Input shape when the list covers nothing', async () => {
    const h = signed(registered, CHANGES_PATH);
    const empty = (h['signature-input'] ?? '').replace(/\(.*?\)/, '()');
    expect(await send(CHANGES_PATH, { ...h, 'signature-input': empty })).toEqual(refused(SHAPE));
  });

  it('names the covered component that is missing', async () => {
    const h = signed(registered, CHANGES_PATH, { components: ['@method', '@target-uri'] });
    expect(await send(CHANGES_PATH, h)).toEqual(
      refused('the signature must cover @method, @target-uri and content-digest; yours does not cover content-digest'),
    );
  });

  it('names every covered component that is missing, not just the first', async () => {
    const h = signed(registered, CHANGES_PATH, { components: ['@method'] });
    expect(await send(CHANGES_PATH, h)).toEqual(
      refused('the signature must cover @method, @target-uri and content-digest; yours does not cover @target-uri and content-digest'),
    );
  });

  const KEYID = 'keyid must be <your DID>#<key id>';

  it('answers the keyid form when there is no keyid parameter', async () => {
    const h = signed(registered, CHANGES_PATH);
    const input = (h['signature-input'] ?? '').replace(/;keyid="[^"]*"/, '');
    expect(await send(CHANGES_PATH, { ...h, 'signature-input': input })).toEqual(refused(KEYID));
  });

  it('answers the keyid form when the keyid has no # in it', async () => {
    const h = signed(registered, CHANGES_PATH);
    const input = (h['signature-input'] ?? '').replace(/;keyid="[^"]*"/, ';keyid="did:abt:zNoFragment"');
    expect(await send(CHANGES_PATH, { ...h, 'signature-input': input })).toEqual(refused(KEYID));
  });

  it('answers the keyid form when the DID in front of the # is empty', async () => {
    const h = signed(registered, CHANGES_PATH);
    const input = (h['signature-input'] ?? '').replace(/;keyid="[^"]*"/, ';keyid="#z6Mkfragment"');
    expect(await send(CHANGES_PATH, { ...h, 'signature-input': input })).toEqual(refused(KEYID));
  });

  it('answers that only ed25519 is supported when alg says anything else', async () => {
    const h = signed(registered, CHANGES_PATH, { alg: 'rsa-pss-sha512' });
    expect(await send(CHANGES_PATH, h)).toEqual(refused('the only supported alg is ed25519'));
  });

  it('answers that created is required when there is no created parameter', async () => {
    const h = signed(registered, CHANGES_PATH);
    const input = (h['signature-input'] ?? '').replace(/;created=\d+/, '');
    expect(await send(CHANGES_PATH, { ...h, 'signature-input': input })).toEqual(
      refused('Signature-Input must carry created, the Unix time in seconds when you signed'),
    );
  });

  it('answers that created is too old, with the window, when created is 600 seconds back', async () => {
    const h = signed(registered, CHANGES_PATH, { created: Math.floor(Date.now() / 1000) - 600 });
    expect(await send(CHANGES_PATH, h)).toEqual(
      refused('created is more than 300 seconds old; created must be within the last 300 seconds, so sign the request again'),
    );
  });

  it('answers that created is ahead of the clock, not that it is old, when created is 60 seconds ahead', async () => {
    const h = signed(registered, CHANGES_PATH, { created: Math.floor(Date.now() / 1000) + 60 });
    expect(await send(CHANGES_PATH, h)).toEqual(
      refused('created is more than 5 seconds in the future; set created to the current Unix time in seconds and sign the request again'),
    );
  });

  it('answers that the Signature header is unreadable when its label does not match Signature-Input', async () => {
    const h = signed(registered, CHANGES_PATH);
    expect(await send(CHANGES_PATH, { ...h, signature: (h.signature ?? '').replace('sig1=', 'other=') })).toEqual(
      refused('the Signature header must hold your signature as <label>=:<base64>: under the same label Signature-Input uses'),
    );
  });

  it('answers that an ed25519 signature is 64 bytes when the decoded signature is shorter', async () => {
    const h = signed(registered, CHANGES_PATH);
    expect(await send(CHANGES_PATH, { ...h, signature: `sig1=:${Buffer.alloc(32, 1).toString('base64')}:` })).toEqual(
      refused('an ed25519 signature is 64 bytes and the one sent is not'),
    );
  });

  it('names a covered derived component this service cannot build', async () => {
    const h = signed(registered, CHANGES_PATH);
    const input = (h['signature-input'] ?? '').replace('"content-digest"', '"content-digest" "@authority"');
    expect(await send(CHANGES_PATH, { ...h, 'signature-input': input })).toEqual(
      refused('this service cannot build the covered component "@authority"; cover @method, @target-uri and header fields only'),
    );
  });

  it('names a covered header the request does not carry', async () => {
    const h = signed(registered, CHANGES_PATH);
    const input = (h['signature-input'] ?? '').replace('"content-digest"', '"content-digest" "x-not-sent"');
    expect(await send(CHANGES_PATH, { ...h, 'signature-input': input })).toEqual(
      refused('the signature covers the header "x-not-sent" but the request does not carry it; send that header with the request'),
    );
  });

  it('answers that the signature does not match when the signature bytes are changed', async () => {
    const h = signed(registered, CHANGES_PATH);
    const bytes = Buffer.from((h.signature ?? '').slice('sig1=:'.length, -1), 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(await send(CHANGES_PATH, { ...h, signature: `sig1=:${bytes.toString('base64')}:` })).toEqual(
      refused('the signature does not match this request; sign the exact method and URL you send, scheme included'),
    );
  });

  it('answers that the signature does not match when the URL signed is not the URL sent', async () => {
    const h = signed(registered, '/jobs/some-other-job/request-changes');
    expect(await send(CHANGES_PATH, h)).toEqual(
      refused('the signature does not match this request; sign the exact method and URL you send, scheme included'),
    );
  });

  it('answers that content-digest does not match when the body sent is not the body signed', async () => {
    const h = signed(registered, CHANGES_PATH);
    expect(await send(CHANGES_PATH, h, '{"tampered":true}')).toEqual(refused('content-digest does not match the request body'));
  });

  it('answers that a signature was already used when the same headers are sent twice', async () => {
    const h = signed(registered, CHANGES_PATH);
    const first = await send(CHANGES_PATH, h);
    expect(first.status).not.toBe(401);
    expect(await send(CHANGES_PATH, h)).toEqual(refused('this signature was already used; sign each request once'));
  });

  it('answers that the signature could not be checked, and never "already used", when the spend store is down', async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: registered.did, githubLogin: 'refusal-reasons-buyer-2' });
    const down: SignatureSpendStorage = {
      findByKeyidAndHash: () => Promise.reject(new Error('spend store unreachable')),
      record: () => Promise.reject(new Error('spend store unreachable')),
    };
    const s = listenWith(down, accounts);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const origin = await listening(s);
      const r = signRequest(registered, 'POST', `${origin}${CHANGES_PATH}`, { body: BODY });
      const answer = await send(
        CHANGES_PATH,
        { 'signature-input': r['signature-input'], signature: r.signature, 'content-digest': r['content-digest'] },
        BODY,
        origin,
      );
      expect(answer).toEqual(
        refused('the signature could not be checked just now; sign a fresh request and try again'),
      );
    } finally {
      logged.mockRestore();
      s.close();
    }
  });

  it('answers a thrown check as an error on our side, never a fault in the signature (adapter level: no route can make the checks throw)', async () => {
    const h = signed(registered, CHANGES_PATH);
    const detail = await verifyWithReason(
      { method: 'POST', targetUri: `${baseUrl}${CHANGES_PATH}`, headers: h },
      () => Promise.reject(new Error('resolver storage failed')),
      { requiredComponents: REQUEST_SIGNATURE_COMPONENTS },
    );
    expect(detail).toEqual({
      kind: 'invalid',
      reason: 'the signature could not be checked just now because of an error on our side; sign a fresh request and try again',
    });
  });

  it('keeps unknown key as its own answer for a DID this service has never heard of', async () => {
    const h = signed(unregistered, CHANGES_PATH);
    expect(await send(CHANGES_PATH, h)).toEqual({ status: 401, body: { error: 'unknown key' } });
  });
});

describe('SW1-08 (b): a check that runs before the key lookup answers the same body for a registered and an unregistered DID', () => {
  const STALE = {
    status: 401,
    body: { error: 'invalid signature: created is more than 300 seconds old; created must be within the last 300 seconds, so sign the request again' },
  };

  it('answers the stale-created body for a registered DID', async () => {
    const h = signed(registered, CHANGES_PATH, { created: Math.floor(Date.now() / 1000) - 600 });
    expect(await send(CHANGES_PATH, h)).toEqual(STALE);
  });

  it('answers the identical stale-created body for an unregistered DID', async () => {
    const h = signed(unregistered, CHANGES_PATH, { created: Math.floor(Date.now() / 1000) - 600 });
    expect(await send(CHANGES_PATH, h)).toEqual(STALE);
  });

  it('answers the identical uncovered-component body for an unregistered DID', async () => {
    const a = signed(registered, CHANGES_PATH, { components: ['@method', '@target-uri'] });
    const b = signed(unregistered, CHANGES_PATH, { components: ['@method', '@target-uri'] });
    const [known, unknown] = [await send(CHANGES_PATH, a), await send(CHANGES_PATH, b)];
    expect(unknown).toEqual(known);
    expect(known.status).toBe(401);
  });
});

describe('SW1-08 (c): GET /capabilities says how a request is signed', () => {
  const PARAGRAPH =
    'A request that proves who sent it carries an RFC 9421 HTTP Message Signature. Send Signature-Input and Signature headers that cover @method, @target-uri and content-digest, with alg "ed25519", a keyid of <your DID>#<key id>, and created set to the Unix time in seconds when you signed, no more than 300 seconds ago. content-digest is sha-256=:<base64 of the SHA-256 of the exact body you send>:. Each signature is accepted once, so sign every request again.';

  it('serves the whole signing paragraph under the signing key, with notice and capabilities still present', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['capabilities', 'notice', 'signing']);
    expect(body.signing).toBe(PARAGRAPH);
  });

  it('builds the paragraph from the constants the verifier uses: the window and every covered component', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    const signing = ((await res.json()) as { signing: string }).signing;
    expect(signing).toContain(`${SIGNATURE_MAX_AGE_SECONDS} seconds`);
    for (const component of REQUEST_SIGNATURE_COMPONENTS) {
      expect(signing).toContain(component);
    }
    expect(REQUEST_SIGNATURE_COMPONENTS).toEqual(['@method', '@target-uri', 'content-digest']);
  });
});

describe('SW1-08 (d): each of the three writers answers the reason, not the bare words', () => {
  const STALE_BODY = {
    error: 'invalid signature: created is more than 300 seconds old; created must be within the last 300 seconds, so sign the request again',
  };
  const stale = (path: string): Headers => signed(registered, path, { created: Math.floor(Date.now() / 1000) - 600 });

  it('didSignature (POST /jobs/:jobId/request-changes) answers the reason', async () => {
    expect(await send(CHANGES_PATH, stale(CHANGES_PATH))).toEqual({ status: 401, body: STALE_BODY });
  });

  it('requireSessionOrSignature (POST /jobs) answers the reason', async () => {
    expect(await send('/jobs', stale('/jobs'))).toEqual({ status: 401, body: STALE_BODY });
  });

  it('requireCallerIsAgentOperator (POST /agents/:agentDid/key-rotation) answers the reason', async () => {
    const path = `/agents/${registered.did}/key-rotation`;
    const body = JSON.stringify({ fromKey: `${registered.did}#zOldKey`, toKey: `${registered.did}#zNewKey` });
    const h = signed(registered, path, { body, created: Math.floor(Date.now() / 1000) - 600 });
    expect(await send(path, h, body)).toEqual({ status: 401, body: STALE_BODY });
  });
});
