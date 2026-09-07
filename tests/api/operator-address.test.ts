// S3, Ruling 4: PATCH /accounts/:did/operator-address is the only way an
// operator's USDC recipient address is ever set. Guarded by
// requireSessionOrSignature, then by the resolved acting party equalling
// :did (an account may only set its own address). Driven at the route
// level with the ordinary signing helper, nothing tampered.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

const VALID_ADDRESS = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';

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

async function patchSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'PATCH', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly repo: MemoryAccountRepository;
  readonly owner: SigningIdentity;
}

async function startApp(): Promise<Started> {
  const repo = new MemoryAccountRepository();
  const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
  await repo.register({ did: owner.did, githubLogin: 'operator-address-owner' });
  const app = createApp(repo);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, repo, owner };
}

describe('PATCH /accounts/:did/operator-address', () => {
  let started: Started;

  beforeAll(async () => {
    started = await startApp();
  });

  afterAll(() => started.server.close());

  it('an unsigned request is refused with 401', async () => {
    const res = await fetch(`${started.baseUrl}/accounts/${started.owner.did}/operator-address`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorAddressEvm: VALID_ADDRESS }),
    });
    expect(res.status).toBe(401);
  });

  it('a registered stranger naming a DIFFERENT account is refused with 403', async () => {
    const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(212));
    await postSigned(started.baseUrl, '/accounts', { did: stranger.did, githubLogin: 'operator-address-stranger' }, stranger);
    const res = await patchSigned(started.baseUrl, `/accounts/${started.owner.did}/operator-address`, { operatorAddressEvm: VALID_ADDRESS }, stranger);
    expect(res.status).toBe(403);
  });

  it('the owner setting their own address succeeds with 200 and the row reads back the new address', async () => {
    const res = await patchSigned(started.baseUrl, `/accounts/${started.owner.did}/operator-address`, { operatorAddressEvm: VALID_ADDRESS }, started.owner);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.operatorAddressEvm).toBe(VALID_ADDRESS);

    const stored = await started.repo.findByDid(started.owner.did);
    expect(stored?.operatorAddressEvm).toBe(VALID_ADDRESS);
  });

  it('a malformed address is refused with 400, and does not overwrite what is on record', async () => {
    // Set a real value first, so this test proves the malformed attempt did
    // not silently clear or corrupt the existing one.
    await patchSigned(started.baseUrl, `/accounts/${started.owner.did}/operator-address`, { operatorAddressEvm: VALID_ADDRESS }, started.owner);

    const res = await patchSigned(started.baseUrl, `/accounts/${started.owner.did}/operator-address`, { operatorAddressEvm: 'not-an-address' }, started.owner);
    expect(res.status).toBe(400);

    const stored = await started.repo.findByDid(started.owner.did);
    expect(stored?.operatorAddressEvm).toBe(VALID_ADDRESS);
  });
});
