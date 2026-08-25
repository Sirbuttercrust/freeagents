// Invariant 2 (MISSION.md) for work-history credentials (R-14): a third party
// verifies the credential with an off-the-shelf W3C verifier, without calling
// this service and without importing any of this service's verification code.
// The credential under test is produced by the PRODUCTION issuance path
// (createCredentialsAdapter(...).issueWorkHistoryCredential), and it attests a
// real job completed through the domain state machine, so the test cannot be
// satisfied by hand-assembling the document. Verification MUST use the
// @digitalbazaar W3C stack (the same one R-2 pinned for delegations); the
// adapter is imported only for its issuance method.
import { fromPublicKey } from '@arcblock/did';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCredentialsAdapter } from '../../../src/adapters/credentials/credentials.js';
import type { WorkHistoryClaim } from '../../../src/adapters/credentials/types.js';
import {
  acceptCriterion,
  completeJob,
  confirmSpec,
  createJob,
  proposeCriteria,
  submitPullRequest,
} from '../../../src/domain/job.js';

const CONTEXT = [
  'https://www.w3.org/ns/credentials/v2',
  'https://w3id.org/security/suites/ed25519-2020/v1',
  { '@vocab': 'https://freeagents.dev/terms#' },
] as const;

function newSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// The did:abt suffix derives from the public key, exactly like agent DIDs, so
// the proof's verification method binds back to the DID without any lookup in
// this service.
function didFromKey(key: Ed25519VerificationKey2020): string {
  const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
  return `did:abt:${fromPublicKey(keyWithBuffer._publicKeyBuffer)}`;
}

// The suite requires a controller at generate time, but the DID is itself
// derived from this key, so a placeholder stands in; it is overwritten
// before the key is used to sign.
async function generateKey(seed: Uint8Array): Promise<Ed25519VerificationKey2020> {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: 'did:abt:pending' });
  key.controller = didFromKey(key);
  return key;
}

// A stranger holding only the credential JSON: resolve the key from the
// proof's verificationMethod fingerprint, check the key actually belongs to
// the claimed issuer, and verify with the off-the-shelf W3C stack. No access
// to the issuer's seed, no call to this service.
async function verifyIndependent(credential: Record<string, unknown>): Promise<boolean> {
  try {
    const proof = credential.proof as Record<string, unknown>;
    const verificationMethod = String(proof.verificationMethod);
    const issuer = String(credential.issuer);

    // A verificationMethod without a '#' yields a malformed fingerprint that
    // fromFingerprint rejects; the catch below maps that to false.
    const fingerprint = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });

    // Binding check: the reconstructed key must belong to the claimed issuer
    // DID, or a spliced verificationMethod (<victim-did>#<attacker-frag>)
    // would verify against the attacker's own key.
    const keyWithBuffer = key as unknown as { _publicKeyBuffer: Uint8Array };
    if (fromPublicKey(keyWithBuffer._publicKeyBuffer) !== issuer.replace(/^did:abt:/, '')) {
      return false;
    }

    key.controller = issuer;
    key.id = verificationMethod;

    const loader = securityLoader();
    loader.addStatic(key.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...key.export({ publicKey: true }),
    });
    loader.addStatic(issuer, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuer,
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

describe('work-history credential, invariant 2 (R-14)', () => {
  let credential: Record<string, unknown>;
  let claim: WorkHistoryClaim;
  let hire: Record<string, unknown>;
  let agentDid: string;
  let issuerDid: string;

  beforeAll(async () => {
    // The platform issuer: DID derived from the seed, like every did:abt.
    const issuerSeed = newSeed();
    const issuerKey = await generateKey(issuerSeed);
    issuerDid = issuerKey.controller;

    // The agent (credential subject), with its own key.
    const agentKey = await generateKey(newSeed());
    agentDid = agentKey.controller;
    const agentVerificationMethod = `${agentDid}#${agentKey.publicKeyMultibase}`;

    // A real completed job through the domain: draft -> proposed ->
    // confirmed -> submitted -> completed, no shortcuts.
    const now = new Date('2026-01-05T12:00:00Z');
    const pullRequestUrl = 'https://github.com/buyer/work-repo/pull/7';
    let job = createJob(
      {
        id: 'job-wh-inv2',
        buyerDid: 'did:abt:zBuyerForWorkHistoryInvariantTwo',
        agentDid,
        repository: 'buyer/work-repo',
        brief: 'Write the quarterly report.',
      },
      now,
    );
    job = proposeCriteria(job, [
      { text: 'The report includes the Q4 numbers', proposedBy: 'agent' },
      { text: 'Delivered as markdown in docs/', proposedBy: 'agent' },
    ]);
    job = acceptCriterion(acceptCriterion(job, 0), 1);
    job = confirmSpec(job, now);
    job = submitPullRequest(job, pullRequestUrl, now);
    const completed = completeJob(job, {
      // Test input data, not a digest: any commit sha stands in for the one
      // GitHub reported.
      mergeCommit: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b',
      completedAt: now,
    });

    claim = {
      jobId: completed.job.id,
      pullRequestUrl,
      mergeCommitSha: completed.completedJob.mergeCommit,
      mergedAt: completed.completedJob.completedAt.toISOString(),
      diffAdditions: 12,
      diffDeletions: 3,
      diffFiles: 2,
      briefHash: completed.job.briefHash,
      specHash: completed.job.confirmedSpecHash as string,
      signedBy: agentVerificationMethod,
      repository: completed.job.repository,
      buyerDid: completed.job.buyerDid,
    };

    const issued = await createCredentialsAdapter({ did: issuerDid, seed: issuerSeed }).issueWorkHistoryCredential(
      agentDid,
      claim,
    );
    credential = issued as unknown as Record<string, unknown>;

    hire = {
      brief: claim.briefHash,
      repository: claim.repository,
      pullRequest: claim.pullRequestUrl,
      mergedAt: claim.mergedAt,
      mergeCommit: claim.mergeCommitSha,
      signedBy: claim.signedBy,
      buyer: claim.buyerDid,
      additions: claim.diffAdditions,
      deletions: claim.diffDeletions,
      filesChanged: claim.diffFiles,
      specHash: claim.specHash,
    };
  });

  it('the invariant-2 test: a stranger holding only the JSON verifies it off-platform', async () => {
    const strangerCopy = JSON.parse(JSON.stringify(credential));
    expect(await verifyIndependent(strangerCopy)).toBe(true);
  });

  it('the wire @context is the W3C v2 credentials context, not v1', async () => {
    expect(credential['@context']).toEqual([...CONTEXT]);
  });

  it('uses the registered Ed25519Signature2020 proof with a proofValue, not the jws regression', async () => {
    const proof = credential.proof as Record<string, unknown>;
    expect(proof.type).toBe('Ed25519Signature2020');
    expect(typeof proof.proofValue).toBe('string');
    expect(String(proof.proofValue)).not.toHaveLength(0);
    // The @arcblock/vc suite emitted jws instead, which no standard verifier
    // recognizes (the regression R-2 closed for delegations).
    expect(proof.jws).toBeUndefined();
  });

  it('attests the completed job: every claim field and the parties round-trip', async () => {
    const subject = credential.credentialSubject as Record<string, unknown>;
    const hire = subject.hire as Record<string, unknown>;
    expect(subject.id).toBe(agentDid);
    expect(hire.pullRequest).toBe(claim.pullRequestUrl);
    expect(hire.mergeCommit).toBe(claim.mergeCommitSha);
    expect(hire.mergedAt).toBe(claim.mergedAt);
    expect(hire.additions).toBe(12);
    expect(hire.deletions).toBe(3);
    expect(hire.filesChanged).toBe(2);
    expect(hire.specHash).toBe(claim.specHash);
    expect(hire.specHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hire.brief).toBe(claim.briefHash);
    expect(hire.signedBy).toBe(claim.signedBy);
    expect(hire.repository).toBe(claim.repository);
    expect(hire.buyer).toBe(claim.buyerDid);
    expect(hire.jobId).toBeUndefined();
    expect(credential.issuer).toBe(issuerDid);
    expect(credential.type).toContain('CompletedHireCredential');
    expect(credential.type).toContain('VerifiableCredential');
    expect(typeof credential.validFrom).toBe('string');
    expect(credential.validFrom).not.toHaveLength(0);
    expect(credential.issuanceDate).toBeUndefined();
  });

  it('a tampered subject FAILS the independent verifier', async () => {
    const tampered = JSON.parse(JSON.stringify(credential));
    const subject = tampered.credentialSubject as Record<string, unknown>;
    subject.id = 'did:abt:zSomeoneElse';
    expect(await verifyIndependent(tampered)).toBe(false);
  });

  it('a tampered claim (merge commit) FAILS the independent verifier', async () => {
    const tampered = JSON.parse(JSON.stringify(credential));
    const subject = tampered.credentialSubject as Record<string, unknown>;
    const hire = subject.hire as Record<string, unknown>;
    hire.mergeCommit = '0'.repeat(40);
    expect(await verifyIndependent(tampered)).toBe(false);
  });

  it('FORGERY: an attacker key claiming the platform DID is rejected by the binding check', async () => {
    // The attacker derives a key from their OWN seed and lies about the
    // controller.
    const attackerKey = await Ed25519VerificationKey2020.generate({
      seed: newSeed(),
      controller: issuerDid,
    });
    // THE SPLICE: prefix the key id with the VICTIM's DID, the fragment is
    // the attacker's own fingerprint.
    attackerKey.id = `${issuerDid}#${attackerKey.publicKeyMultibase}`;

    const forgedCredential = {
      '@context': [...CONTEXT],
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: ['VerifiableCredential', 'CompletedHireCredential'],
      issuer: issuerDid,
      validFrom: new Date().toISOString(),
      credentialSubject: { id: agentDid, hire },
    };

    const loader = securityLoader();
    loader.addStatic(attackerKey.id, {
      '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
      ...attackerKey.export({ publicKey: true }),
    });
    loader.addStatic(issuerDid, {
      '@context': 'https://www.w3.org/ns/did/v1',
      id: issuerDid,
      assertionMethod: [attackerKey.id],
      verificationMethod: [
        {
          '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
          ...attackerKey.export({ publicKey: true }),
        },
      ],
    });
    const documentLoader = loader.build();

    // The signature WILL verify against the attacker's key, so only the
    // binding check (key does not belong to the claimed issuer) can reject it.
    const forged = await vc.issue({
      credential: forgedCredential,
      suite: new Ed25519Signature2020({ key: attackerKey }),
      documentLoader,
    });
    expect(await verifyIndependent(forged)).toBe(false);
  });

  it('a document with no proof at all is rejected, not an exception', async () => {
    // Shape guard: a stranger handed garbage gets a clean false.
    expect(await verifyIndependent({})).toBe(false);
  });

  it('no key material in the signed document', async () => {
    // The public key in the proof metadata is the point of the record, not a
    // leak; anything matching a secret stem would be.
    const wire = JSON.stringify(credential).toLowerCase();
    for (const stem of ['privatekey', 'secretkey', 'secret', 'keypair', 'mnemonic']) {
      expect(wire).not.toContain(stem);
    }
  });
});
