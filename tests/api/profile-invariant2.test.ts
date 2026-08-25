// R-17's stated acceptance criterion: a test asserts the absence of a
// blended evidence score (MISSION invariant 5, ENT-11.5, decision D1). Two
// halves, mirroring how tests/architecture/domain-purity.test.ts proves an
// architectural rule by reading source rather than trusting convention, and
// how tests/api/credential-resolve.test.ts proves invariant 2 by handing a
// stranger only the wire response, never the service:
//   - the response never carries a summed/ranked field (behavioural)
//   - the profile code path never computes one (structural)
// Route-shape assertions (counts, 404, 503, cross-tenant isolation) live in
// tests/api/profile.test.ts; this file owns only the "never blended" claim.
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';

import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import * as vc from '@digitalbazaar/vc';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialResolver } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { MemoryAgentRepository, MemoryCredentialRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';

const here = dirname(fileURLToPath(import.meta.url));

// Generic identifiers only (public repository).
const ISSUER_DID = 'did:abt:platform-inv2';
const OPERATOR_DID = 'did:abt:op-profile-inv2';
const AGENT_DID = 'did:abt:agent-profile-inv2';
const COMPLETED_JOB_ID = 'job-profile-inv2-1';

const BLENDED_IDENTIFIER = /(score|total|rating|overall|reputation|points|rank|aggregate)/i;

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

// // and /* */ comments stripped before the identifier scan, or this test
// trips on profile.ts's own header prose ("no total, no sum, no score").
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function collectKeysAndNumbers(value: unknown, keys: string[], numbers: number[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeysAndNumbers(entry, keys, numbers));
    return;
  }
  if (typeof value === 'number') {
    numbers.push(value);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      collectKeysAndNumbers(nested, keys, numbers);
    }
  }
}

function hasKeyDeep(value: unknown, targetKey: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, targetKey));
  if (value !== null && typeof value === 'object') {
    if (targetKey in (value as Record<string, unknown>)) return true;
    return Object.values(value).some((entry) => hasKeyDeep(entry, targetKey));
  }
  return false;
}

interface ProfileBody {
  readonly evidence: {
    readonly verifiedHire: { readonly tier: string; readonly label: string; readonly items: readonly Record<string, unknown>[] };
    readonly verifiedPriorWork: { readonly tier: string; readonly label: string };
    readonly portfolio: { readonly tier: string; readonly label: string };
  };
}

let server: Server;
let baseUrl: string;
let keyId: string;
let key: Awaited<ReturnType<typeof Ed25519VerificationKey2020.generate>>;
let signed: VerifiableCredential;

beforeAll(async () => {
  const seed = new Uint8Array(randomBytes(32));
  key = await Ed25519VerificationKey2020.generate({ seed, controller: ISSUER_DID });
  keyId = `${ISSUER_DID}#${key.publicKeyMultibase}`;

  const credentialRepo = new MemoryCredentialRepository();
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: AGENT_DID,
    operatorDid: OPERATOR_DID,
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: null,
  });

  const app = createApp(
    new MemoryOperatorRepository(),
    agentRepo,
    undefined,
    undefined,
    undefined,
    createCredentialResolver(credentialRepo),
    credentialRepo,
  );
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${portOf(server)}`;

  const credential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `${baseUrl}/v1/credentials/${COMPLETED_JOB_ID}`,
    type: ['VerifiableCredential', 'CompletedHireCredential'],
    issuer: ISSUER_DID,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: AGENT_DID,
      jobId: COMPLETED_JOB_ID,
      pullRequestUrl: 'https://github.com/buyer/target-repo/pull/91',
      mergeCommitSha: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e',
      mergedAt: '2026-08-22T09:00:00.000Z',
      diffAdditions: 8,
      diffDeletions: 2,
      specHash: 'sha256:spec-inv2',
      filesChanged: 2,
      repository: 'buyer/target-repo',
      signedBy: `${AGENT_DID}#${COMPLETED_JOB_ID}`,
      buyerDid: 'did:abt:buyer-profile-inv2',
    },
  };

  const loader = securityLoader();
  loader.addStatic(keyId, {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    ...key.export({ publicKey: true }),
  });
  loader.addStatic(ISSUER_DID, {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: ISSUER_DID,
    assertionMethod: [keyId],
    verificationMethod: [
      { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) },
    ],
  });

  signed = (await vc.issue({
    credential,
    suite: new Ed25519Signature2020({ key }),
    documentLoader: loader.build(),
  })) as unknown as VerifiableCredential;

  await credentialRepo.save({ completedJobId: COMPLETED_JOB_ID, subjectDid: AGENT_DID, document: signed });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('R-17 invariant 2: no blended evidence score, ever', () => {
  it('no blended-score key appears in the response, and the numeric footprint is exactly the tier counts', async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    const body: unknown = await res.json();

    const keys: string[] = [];
    const numbers: number[] = [];
    collectKeysAndNumbers(body, keys, numbers);

    expect(keys.filter((key_) => BLENDED_IDENTIFIER.test(key_))).toEqual([]);

    // Prior-work and portfolio have no domain type yet (A-R17-4), so this
    // fixture's only reachable tier is verifiedHire with one item: the sum
    // of all three counts always equals that one tier's own count, and a
    // bare "no number equals the sum" check cannot tell a blended field
    // apart from a legitimate one on a fixture this small. Assert the exact
    // footprint instead: 0 (the two empty tiers) and 1 (the one hire), and
    // nothing else, appears anywhere in the body.
    expect([...new Set(numbers)].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('no blended-score identifier appears in the profile code path', () => {
    const domainSrc = stripComments(readFileSync(join(here, '../../src/domain/profile.ts'), 'utf8'));
    expect(BLENDED_IDENTIFIER.test(domainSrc), 'src/domain/profile.ts').toBe(false);

    // Two disjoint blocks, not the whole span between them: hireItem sits
    // beside agentProjection near the top of the file, the route is
    // registered near the bottom, and hundreds of unrelated route handlers
    // sit in between. Slicing the whole span would scan code this issue
    // never touched.
    const appSrc = readFileSync(join(here, '../../src/api/app.ts'), 'utf8');
    const hireItemStart = appSrc.indexOf('function hireItem');
    const hireItemEnd = appSrc.indexOf('\n}\n', hireItemStart);
    const routeStart = appSrc.indexOf("app.get('/agents/:agentDid/profile'");
    const routeEnd = appSrc.indexOf("app.get('/agents/:agentDid/card'", routeStart);
    expect(hireItemStart, 'hireItem helper found').toBeGreaterThan(-1);
    expect(hireItemEnd, 'hireItem helper closes').toBeGreaterThan(hireItemStart);
    expect(routeStart, 'profile route found').toBeGreaterThan(-1);
    expect(routeEnd, 'profile route closes').toBeGreaterThan(routeStart);
    const profileCodePath = stripComments(
      appSrc.slice(hireItemStart, hireItemEnd) + appSrc.slice(routeStart, routeEnd),
    );
    expect(BLENDED_IDENTIFIER.test(profileCodePath), 'the profile route in src/api/app.ts').toBe(false);
  });

  it('the three tiers are labelled, distinctly, each beside its own tier', async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    const body = (await res.json()) as ProfileBody;

    expect(body.evidence.verifiedHire).toMatchObject({ tier: 'verified-hire', label: 'Verified hire' });
    expect(body.evidence.verifiedPriorWork).toMatchObject({ tier: 'verified-prior-work', label: 'Verified prior work' });
    expect(body.evidence.portfolio).toMatchObject({ tier: 'portfolio', label: 'Portfolio claim' });

    const labels = [body.evidence.verifiedHire.label, body.evidence.verifiedPriorWork.label, body.evidence.portfolio.label];
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('the verified-hire count is checkable by a third party, without calling this service', async () => {
    const profileRes = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    const body = (await profileRes.json()) as ProfileBody;
    const item = body.evidence.verifiedHire.items[0];
    const credentialPath = item?.credentialPath as string;

    // The verifier's whole input is the resolved credential plus the
    // issuer's publicly registered key: no call into the profile response,
    // no adapter, no storage.
    const credRes = await fetch(`${baseUrl}${credentialPath}`);
    const fetched = (await credRes.json()) as VerifiableCredential;

    const loader = securityLoader();
    loader.addStatic(keyId, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(ISSUER_DID, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: ISSUER_DID,
      assertionMethod: [keyId],
      verificationMethod: [
        { '@context': 'https://w3id.org/security/suites/ed25519-2020/v1', ...key.export({ publicKey: true }) },
      ],
    });

    const verified = await vc.verifyCredential({
      credential: fetched,
      suite: new Ed25519Signature2020(),
      documentLoader: loader.build(),
    });
    expect(verified.verified).toBe(true);

    // The profile echoed the credential's own facts; it did not invent them.
    expect(item?.pullRequestUrl).toBe(fetched.credentialSubject.pullRequestUrl);
    expect(item?.mergeCommitSha).toBe(fetched.credentialSubject.mergeCommitSha);
  });

  it('the profile embeds no credential document: no proof, no @context under evidence', async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT_DID}/profile`);
    const body = (await res.json()) as ProfileBody;

    expect(hasKeyDeep(body.evidence, 'proof')).toBe(false);
    expect(hasKeyDeep(body.evidence, '@context')).toBe(false);
  });
});
