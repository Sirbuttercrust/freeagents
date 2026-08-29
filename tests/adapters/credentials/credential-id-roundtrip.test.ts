// R-40 (#88): the credential id is the resolution handle. A credential issued
// by the real adapter must be resolvable by the id it itself publishes. Before
// this, the issuer minted urn:uuid ids while storage keyed on the completed job
// id, so the platform 404'd on its own credentials. The round-trip case below
// reads the id OFF the issued document rather than constructing one, which is
// exactly the weakness the PR 78 verdict named.
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { describe, expect, it } from 'vitest';

import { createCredentialsAdapter } from '../../../src/adapters/credentials/credentials.js';
import type { CredentialsIssuer, WorkHistoryClaim } from '../../../src/adapters/credentials/types.js';
import { MemoryCredentialRepository } from '../../../src/adapters/storage/memory.js';
import { credentialLookupKey } from '../../../src/adapters/storage/types.js';

const claim: WorkHistoryClaim = {
  jobId: 'job-r40-roundtrip',
  pullRequestUrl: 'https://github.com/buyer/target-repo/pull/1',
  mergeCommitSha: '3f8a2c1d9e7b4a5f6c8d0e1f2a3b4c5d6e7f8a9b',
  mergedAt: '2026-01-03T00:00:00.000Z',
  diffAdditions: 1,
  diffDeletions: 1,
  diffFiles: 1,
  briefHash: 'sha256:brief',
  specHash: 'sha256:spec',
  repository: 'buyer/target-repo',
  signedBy: 'did:abt:agent#job-r40-roundtrip',
  buyerDid: 'did:example:buyer',
};

const issuer: CredentialsIssuer = { did: 'did:abt:platform', seed: new Uint8Array(32) };

// A stranger holding only the credential JSON, the same construction as
// work-history-invariant2.test.ts:58-107 minus the DID-binding forgery check,
// which that file already owns. The point here is that a URL-shaped `id`
// under the W3C v2 credentials context still signs and verifies with an
// off-the-shelf verifier: `id` is covered by the proof, so this is not a
// formality.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuerDid = String(credential.issuer);

    const fingerprint = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });
    key.controller = issuerDid;
    key.id = verificationMethod;

    const loader = securityLoader();
    loader.addStatic(key.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(issuerDid, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuerDid,
      assertionMethod: [key.id],
      verificationMethod: [
        {
          '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
          ...key.export({ publicKey: true }),
        },
      ],
    });
    const documentLoader = loader.build();

    const result = await vc.verifyCredential({
      credential,
      suite: new Ed25519Signature2020(),
      documentLoader,
    });
    return result.verified === true;
  } catch {
    return false;
  }
}

describe('credential id is the resolution handle (R-40)', () => {
  it('a credential issued by the real adapter resolves by the id it carries', async () => {
    const repo = new MemoryCredentialRepository();
    const adapter = createCredentialsAdapter(issuer, repo, 'https://credentials.example');

    const issued = await adapter.issueWorkHistoryCredential('did:abt:agent', claim);
    await repo.save({ completedJobId: claim.jobId, subjectDid: 'did:abt:agent', document: issued });

    // issued.id is read, never built. Under the old urn:uuid issuer this
    // returns null / throws CredentialNotFoundError, the failure this case
    // exists to catch.
    await expect(repo.findByDocumentId(issued.id)).resolves.toEqual(issued);
    // And through the serve half the API actually calls.
    await expect(adapter.getCredential(issued.id)).resolves.toEqual(issued);
  });

  it('the issued id is the resolvable shape, not a uuid', async () => {
    const repo = new MemoryCredentialRepository();
    const adapter = createCredentialsAdapter(issuer, repo, 'https://credentials.example');

    const issued = await adapter.issueWorkHistoryCredential('did:abt:agent', claim);

    expect(issued.id).toBe('https://credentials.example/v1/credentials/job-r40-roundtrip');
    expect(issued.id.startsWith('urn:uuid:')).toBe(false);
    expect(credentialLookupKey(issued.id)).toBe(claim.jobId);
  });

  it('the id is stable across issuances of the same job, not regenerated', async () => {
    const first = await createCredentialsAdapter(
      issuer,
      new MemoryCredentialRepository(),
      'https://credentials.example',
    ).issueWorkHistoryCredential('did:abt:agent', claim);
    const second = await createCredentialsAdapter(
      issuer,
      new MemoryCredentialRepository(),
      'https://credentials.example',
    ).issueWorkHistoryCredential('did:abt:agent', claim);

    expect(first.id).toBe(second.id);
  });

  it('the base URL is configurable and a trailing slash does not double the separator', async () => {
    const adapter = createCredentialsAdapter(issuer, new MemoryCredentialRepository(), 'https://credentials.example/');

    const issued = await adapter.issueWorkHistoryCredential('did:abt:agent', claim);

    expect(issued.id).toBe('https://credentials.example/v1/credentials/job-r40-roundtrip');
  });

  it('the internal job id stays off the wire', async () => {
    const adapter = createCredentialsAdapter(issuer, new MemoryCredentialRepository(), 'https://credentials.example');

    const issued = await adapter.issueWorkHistoryCredential('did:abt:agent', claim);

    // Beside the id assertion on purpose, so the two rules (id carries the
    // job id, credentialSubject.hire does not) are read together.
    const hire = issued.credentialSubject.hire as unknown as Record<string, unknown>;
    expect('jobId' in hire).toBe(false);
  });

  it('a stranger verifies the URL-id credential off-platform, with no call to this service', async () => {
    const adapter = createCredentialsAdapter(issuer, new MemoryCredentialRepository(), 'https://credentials.example');

    const issued = await adapter.issueWorkHistoryCredential('did:abt:agent', claim);

    expect(await verifyIndependent(JSON.parse(JSON.stringify(issued)) as Record<string, unknown>)).toBe(true);

    const tampered = JSON.parse(JSON.stringify(issued)) as Record<string, unknown>;
    (tampered.credentialSubject as Record<string, unknown>).id = 'did:abt:zSomeoneElse';
    expect(await verifyIndependent(tampered)).toBe(false);
  });
});
