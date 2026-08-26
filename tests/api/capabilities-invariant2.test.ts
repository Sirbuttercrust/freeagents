// Invariant 2 (MISSION.md): a third party can verify what this service
// stores without calling it. R-23 touches identity, so the strongest honest
// evidence this PR can offer is the boundary itself: the two reads a skeptic
// needs to check a claim (an agent's record, a resolved credential) must
// never require an account, or invariant 2 is dead the moment a human adds a
// gate to one of them without noticing. This file holds that in place, and
// separately checks the declaration itself is internally consistent and
// leaks no key material.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { CAPABILITIES, VERIFICATION_CAPABILITY_IDS } from '../../src/domain/access.js';
import { createCredentialResolver } from '../../src/adapters/credentials/credentials.js';
import type { VerifiableCredential } from '../../src/adapters/credentials/types.js';
import { MemoryCredentialRepository } from '../../src/adapters/storage/memory.js';

// Names that would mean key material leaked into storage or the wire.
// Matched by substring, so publicKeyMultibase / privateKeyMultibase and the
// like are all caught by their stems. Copied verbatim from
// tests/api/operator-invariant2.test.ts:20-34; not extracted to a shared
// module, since that would be a seventh file the plan does not allow.
const KEY_MATERIAL_STEMS = ['publicKey', 'privateKey', 'secret', 'keyPair', 'mnemonic'];
function findKeyMaterialFields(obj: unknown, path = ''): string[] {
  const hits: string[] = [];
  if (obj === null || typeof obj !== 'object') return hits;
  for (const [key, value] of Object.entries(obj)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (KEY_MATERIAL_STEMS.some((stem) => key.toLowerCase().includes(stem.toLowerCase()))) {
      hits.push(here);
    }
    if (value !== null && typeof value === 'object') {
      hits.push(...findKeyMaterialFields(value, here));
    }
  }
  return hits;
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

describe('GET /capabilities, invariant 2', () => {
  it('pins the response key set exactly, not a subset', async () => {
    const server = await listen(createApp());
    try {
      const baseUrl = `http://127.0.0.1:${portOf(server)}`;
      const res = await fetch(`${baseUrl}/capabilities`);
      const body = (await res.json()) as { notice: unknown; capabilities: Array<Record<string, unknown>> };
      expect(Object.keys(body).sort()).toEqual(['capabilities', 'notice']);
      for (const cap of body.capabilities) {
        expect(Object.keys(cap).sort()).toEqual(['access', 'id', 'identityField', 'method', 'path', 'reason']);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('no verification capability may ever require identity', () => {
    // agent.browse and credential.verify are the reads a skeptic needs to
    // check a claim from outside this service. If either ever required an
    // account, invariant 2 would be dead: a stranger could no longer verify
    // a "verified" badge without us.
    expect(VERIFICATION_CAPABILITY_IDS.length).toBeGreaterThan(0);
    for (const id of VERIFICATION_CAPABILITY_IDS) {
      const cap = CAPABILITIES.find((c) => c.id === id);
      expect(cap, `${id} must be declared`).toBeDefined();
      expect(cap?.access).toBe('public');
      expect(cap?.identityField).toBeNull();
    }
  });

  it('serves the declared values verbatim, not just the declared key set', async () => {
    // tests/api/capabilities-invariant2.test.ts:52 above pins the key set;
    // this pins the values behind them. capabilityProjection's fields are
    // exactly Capability's fields, so the served array must equal
    // CAPABILITIES itself - a swapped method/path, a rewritten reason, or a
    // wrong identityField would all pass the key-set check and fail here.
    const server = await listen(createApp());
    try {
      const baseUrl = `http://127.0.0.1:${portOf(server)}`;
      const res = await fetch(`${baseUrl}/capabilities`);
      const body = (await res.json()) as { capabilities: unknown };
      expect(body.capabilities).toEqual(CAPABILITIES);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the declaration is internally consistent: identityField and access always agree', () => {
    for (const cap of CAPABILITIES) {
      if (cap.access === 'identified') {
        expect(cap.identityField, `${cap.id} is identified and must name a field`).not.toBeNull();
      } else {
        expect(cap.identityField, `${cap.id} is public and must not name a field`).toBeNull();
      }
    }
  });

  it('credential.verify resolves a stored credential with no headers, self-contained enough for an off-platform verifier', async () => {
    const credentialRepo = new MemoryCredentialRepository();
    const completedJobId = 'job-capabilities-inv2';
    const document: VerifiableCredential = {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://w3id.org/security/suites/ed25519-2020/v1',
        { '@vocab': 'https://freeagents.dev/terms#' },
      ],
      id: `https://freeagents.example/v1/credentials/${completedJobId}`,
      type: ['VerifiableCredential', 'CompletedHireCredential'],
      issuer: 'did:abt:capabilities-inv2-issuer',
      validFrom: '2026-08-21T12:00:00.000Z',
      credentialSubject: {
        id: 'did:abt:capabilities-inv2-subject',
        hire: {
          brief: 'A brief for the capabilities invariant-2 test.',
          repository: 'buyer/target-repo',
          pullRequest: 'https://github.com/buyer/target-repo/pull/1',
          mergedAt: '2026-08-21T12:00:00.000Z',
          mergeCommit: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
          signedBy: 'did:abt:capabilities-inv2-subject#key-1',
          buyer: 'did:abt:capabilities-inv2-buyer',
          additions: 12,
          deletions: 4,
          filesChanged: 1,
        },
      },
      proof: {
        type: 'Ed25519Signature2020',
        created: '2026-08-21T12:00:00.000Z',
        verificationMethod: 'did:abt:capabilities-inv2-issuer#key-1',
        proofPurpose: 'assertionMethod',
        proofValue: 'z2fakeProofValueForCapabilitiesInvariant2Test',
      },
    };
    await credentialRepo.save({
      completedJobId,
      subjectDid: 'did:abt:capabilities-inv2-subject',
      document,
    });

    const server = await listen(createApp(undefined, undefined, undefined, undefined, undefined, createCredentialResolver(credentialRepo)));
    try {
      const baseUrl = `http://127.0.0.1:${portOf(server)}`;
      const res = await fetch(`${baseUrl}/v1/credentials/${completedJobId}`);
      expect(res.status).toBe(200);
      const fetched = (await res.json()) as VerifiableCredential;
      expect(fetched.proof.type).toBe('Ed25519Signature2020');
      expect(fetched.issuer).toBeTruthy();
      expect(fetched.proof).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('carries no key material in the response', async () => {
    const server = await listen(createApp());
    try {
      const baseUrl = `http://127.0.0.1:${portOf(server)}`;
      const res = await fetch(`${baseUrl}/capabilities`);
      const body = await res.json();
      expect(findKeyMaterialFields(body)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
