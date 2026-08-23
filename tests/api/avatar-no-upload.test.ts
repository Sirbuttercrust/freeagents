import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import type { IdentityAdapter } from '../../src/adapters/identity/types.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE, type Delegation } from '../../src/domain/agent.js';
import { renderAvatar } from '../../src/api/avatar.js';

/**
 * THE ACCEPT LINE'S OTHER HALF: no upload path exists anywhere.
 *
 * MISSION.md forbids user-uploaded imagery outright - an uploaded image is a
 * storage cost, a moderation duty, and an impersonation surface. So the
 * avatar must be derivable and ONLY derivable. Two independent proofs:
 *
 *   (a) BEHAVIOURAL - the only upload vector a JSON API has is a request
 *       body, so a client posts an extra `avatar` field and the record must
 *       come back carrying the DID-derived string instead, unchanged on
 *       read-back.
 *
 *   (b) STRUCTURAL - neither file involved may contain upload machinery
 *       (multipart parsers, raw-body handlers, binary content types), and
 *       app.ts must pin the literal derivation `renderAvatar(row.did)`, not
 *       merely emit a key named avatar from somewhere else.
 *
 * The identity adapter is wrapped to accept every delegation because
 * delegation VALIDITY has its own invariant-2 suites; what this file proves
 * is that even a fully accepted registration cannot carry an avatar in.
 */

const here = dirname(fileURLToPath(import.meta.url));

const OPERATOR_DID = 'did:abt:op-avatar';
const AGENT_DID = 'did:abt:agent-avatar';
const FORGED_AVATAR = '<svg>forged</svg>';

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

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('avatars are derived, never uploaded (R-21)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp(new MemoryOperatorRepository(), new MemoryAgentRepository(), acceptingIdentity).listen(0);
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

  it('an avatar field in the POST /agents body is ignored, and the derived avatar is served instead', async () => {
    const reg = await postJson(baseUrl, '/operators', { did: OPERATOR_DID, githubLogin: 'operator-avatar' });
    expect(reg.status).toBe(201);

    const res = await postJson(baseUrl, '/agents', {
      did: AGENT_DID,
      operator: OPERATOR_DID,
      delegation: delegationFixture(),
      name: 'scout',
      skills: ['triage'],
      avatar: FORGED_AVATAR,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    // The wire carries exactly the derivation of the posted DID...
    expect(body.avatar).toBe(renderAvatar(AGENT_DID));
    // ...which is by construction not what the client sent.
    expect(body.avatar).not.toBe(FORGED_AVATAR);

    // And the stored record agrees: read-back serves the same derived
    // string, so nothing user-chosen slipped into storage either.
    const read = await fetch(`${baseUrl}/agents/${AGENT_DID}`);
    expect(read.status).toBe(200);
    const readBack = (await read.json()) as Record<string, unknown>;
    expect(readBack.avatar).toBe(renderAvatar(AGENT_DID));
    expect(readBack.avatar).not.toBe(FORGED_AVATAR);
  });

  it('no upload machinery exists in either file involved', () => {
    // Narrow token list over two named files: multipart parsers, raw-body
    // handlers, binary content types. A grep-style check is deliberately
    // scoped this tightly so it cannot cry wolf on unrelated prose.
    const UPLOAD_IDIOM = /multer|busboy|formidable|express\.raw|octet-stream/i;
    const appSrc = readFileSync(join(here, '../../src/api/app.ts'), 'utf8');
    const avatarSrc = readFileSync(join(here, '../../src/api/avatar.ts'), 'utf8');
    expect(UPLOAD_IDIOM.test(appSrc), 'app.ts mentions an upload idiom').toBe(false);
    expect(UPLOAD_IDIOM.test(avatarSrc), 'avatar.ts mentions an upload idiom').toBe(false);

    // Pin the DERIVATION, not just a key: the projection must compute the
    // avatar from the row's own DID at serve time.
    expect(appSrc).toContain('renderAvatar(row.did)');
  });
});
