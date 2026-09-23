import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { IdentityAdapter } from '../../src/adapters/identity/types.js';
import { MemoryAgentRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE, type Delegation } from '../../src/domain/agent.js';
import { defaultAvatar } from '../../src/domain/avatar-spec.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';

/**
 * THE ACCEPT LINE'S OTHER HALF: no upload path exists anywhere.
 *
 * MISSION.md forbids user-uploaded imagery outright - an uploaded image is a
 * storage cost, a moderation duty, and an impersonation surface. So the
 * avatar is a spec of three keys from fixed sets (ENT-2.3 as amended, AV1),
 * written only by the operator-gated PUT /agents/:agentDid/avatar, and
 * otherwise derived from the DID. Two independent proofs that nothing else
 * gets in:
 *
 *   (a) BEHAVIOURAL - the only upload vector a JSON API has is a request
 *       body, so a client posts extra `avatar` and `avatarSpec` fields at
 *       registration and the record must come back carrying the DID default
 *       instead, unchanged on read-back, with no image-carrying field.
 *
 *   (b) STRUCTURAL - app.ts may contain no upload machinery (multipart
 *       parsers, raw-body handlers, binary content types), and must pin the
 *       literal resolution, not merely emit a key named avatarSpec from
 *       somewhere else.
 *
 * The identity adapter is wrapped to accept every delegation because
 * delegation VALIDITY has its own invariant-2 suites; what this file proves
 * is that even a fully accepted registration cannot carry an avatar in.
 */

const here = dirname(fileURLToPath(import.meta.url));

const OPERATOR_DID = 'did:abt:op-avatar';
const AGENT_DID = 'did:abt:agent-avatar';
const FORGED_AVATAR = '<svg>forged</svg>';
const FORGED_SPEC = { shape: 'ghost', face: 'mouth', colour: 'c1' };

function delegationFixture(): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-avatar-no-upload',
    type: ['VerifiableCredential', DELEGATION_TYPE],
    issuer: OPERATOR_DID,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: AGENT_DID },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${AGENT_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-accepted-by-the-wrapped-adapter-below',
    },
  };
}

// Same spread-wrap pattern as the e2e smoke test: real adapter everywhere
// except the one method this flow needs answered.
const acceptingIdentity: IdentityAdapter = {
  ...createIdentityAdapter(),
  verifyDelegation: () => Promise.resolve(true),
};

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  authHeader: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader },
    body: JSON.stringify(body),
  });
}

describe('avatars are derived, never uploaded (R-21)', () => {
  let server: Server;
  let baseUrl: string;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    const sessionAdapter = testSessionAdapter();
    server = createApp(
      new MemoryAccountRepository(),
      new MemoryAgentRepository(),
      acceptingIdentity,
      undefined,
      undefined,
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
    const token = await mintSessionToken(sessionAdapter);
    authHeader = { authorization: `Bearer ${token}` };
  });

  afterAll(() => {
    server.close();
  });

  it('an avatar field in the POST /agents body is ignored, and the DID default is served instead', async () => {
    const reg = await postJson(baseUrl, '/accounts', { did: OPERATOR_DID, githubLogin: 'test-session-user' }, authHeader);
    expect(reg.status).toBe(201);

    const res = await postJson(baseUrl, '/agents', {
      did: AGENT_DID,
      delegation: delegationFixture(),
      name: 'scout',
      skills: ['triage'],
      avatar: FORGED_AVATAR,
      avatarSpec: FORGED_SPEC,
    }, authHeader);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    // The wire carries exactly the derivation of the posted DID, and no
    // field that could carry an image at all. AV2 removed the legacy SVG
    // `avatar` field; the only avatar on the wire is a spec of three keys.
    expect(body.avatarSpec).toEqual(defaultAvatar(AGENT_DID));
    expect(body.avatarSpec).not.toEqual(FORGED_SPEC);
    expect('avatar' in body).toBe(false);

    // And the stored record agrees: registration is not a way in. The only
    // write path is PUT /agents/:agentDid/avatar, operator-gated and
    // validated against the fixed sets (tests/api/avatar-override.test.ts).
    const read = await fetch(`${baseUrl}/agents/${AGENT_DID}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.avatarSpec).toEqual(defaultAvatar(AGENT_DID));
    expect('avatar' in readBack).toBe(false);
  });

  it('no upload machinery exists in the app', () => {
    // Narrow token list: multipart parsers, raw-body handlers, binary
    // content types. Scoped this tightly so it cannot cry wolf on prose.
    const UPLOAD_IDIOM = /multer|busboy|formidable|express\.raw|octet-stream/i;
    const appSrc = readFileSync(join(here, '../../src/api/app.ts'), 'utf8');
    expect(UPLOAD_IDIOM.test(appSrc), 'app.ts mentions an upload idiom').toBe(false);

    // Pin the RESOLUTION, not just a key: the projection computes the avatar
    // from the stored override and the row's own DID at serve time.
    expect(appSrc).toContain('avatarSpec: resolveAvatar(row.avatarSpec, row.did)');
  });
});
