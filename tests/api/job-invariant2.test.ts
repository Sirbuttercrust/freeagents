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
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import { DELEGATION_TYPE } from '../../src/domain/agent.js';

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

async function postJson(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
