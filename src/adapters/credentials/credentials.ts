import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { NotImplementedError } from '../not-implemented.js';
import { createCredentialRepository } from '../storage/storage.js';
import { CredentialNotFoundError, type CredentialRepository } from '../storage/types.js';
import type { CredentialsAdapter, CredentialsIssuer, VerifiableCredential, WorkHistoryClaim } from './types.js';

const CAPABILITY = 'credentials';
const DEFAULT_PLATFORM_DID = 'did:abt:freeagents-platform';

// Mirrors the storage factory's stance (storage.ts:12-17): an unconfigured
// deployment announces itself rather than pretending to be configured. A
// missing or malformed seed still returns a usable issuer (dev/test mode)
// but the credentials it signs will not verify past this process's
// lifetime, since the seed backing the proof is thrown away on restart.
export function platformIssuerFromEnv(): CredentialsIssuer {
  const did = process.env.FREEAGENTS_PLATFORM_DID ?? DEFAULT_PLATFORM_DID;
  const hex = process.env.FREEAGENTS_PLATFORM_SEED;
  if (hex !== undefined && /^(0x)?[0-9a-f]{64}$/i.test(hex)) {
    return { did, seed: Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex')) };
  }
  console.warn(
    'credentials: FREEAGENTS_PLATFORM_SEED is not set (or is not 64 hex characters); ' +
      'issuing with a random ephemeral key. Credentials issued now will not verify after ' +
      'a restart. This is a dev/test mode, not production issuance.'
  );
  return { did, seed: crypto.getRandomValues(new Uint8Array(32)) };
}

// The serve half, shared by both factories: resolve a stored credential by
// its id (R-15). The repository normalizes the id to its lookup key; a
// missing credential is the domain error the API maps to 404.
async function resolveStoredCredential(
  credentialRepo: CredentialRepository,
  credentialId: string,
): Promise<VerifiableCredential> {
  const document = await credentialRepo.findByDocumentId(credentialId);
  if (document === null) {
    throw new CredentialNotFoundError(credentialId);
  }
  return document;
}

// Issuance signs with the W3C-conformant Ed25519Signature2020 suite
// (@digitalbazaar/*), not @arcblock/vc: the ArcBlock suite emits a `jws`
// proof that no standard W3C verifier recognizes, and invariant 2 requires
// that a stranger verify our credentials with an off-the-shelf verifier
// (tests/api/agent-invariant2.test.ts records the jws regression R-2 closed).
// Verification is deliberately left unimplemented: it belongs to third
// parties (invariant 2), not to this factory. Resolution (R-15) is real:
// the adapter serves the bytes it was given.
//
// The full adapter: real issuance (R-14, widened to the hire wire shape by
// R-35) and real resolution (R-15). The issuer defaults to the env-derived
// platform issuer (platformIssuerFromEnv above); the app's default for
// serving without issuing is createCredentialResolver below, until R-36
// wires this adapter into the merge route.
export function createCredentialsAdapter(
  issuer: CredentialsIssuer = platformIssuerFromEnv(),
  credentialRepo: CredentialRepository = createCredentialRepository(),
): CredentialsAdapter {
  return {
    async issueWorkHistoryCredential(subjectDid: string, claim: WorkHistoryClaim): Promise<VerifiableCredential> {
      const credential = {
        '@context': [
          'https://www.w3.org/ns/credentials/v2',
          'https://w3id.org/security/suites/ed25519-2020/v1',
          { '@vocab': 'https://freeagents.dev/terms#' },
        ],
        id: `urn:uuid:${crypto.randomUUID()}`,
        type: ['VerifiableCredential', 'CompletedHireCredential'],
        issuer: issuer.did,
        validFrom: new Date().toISOString(),
        credentialSubject: {
          id: subjectDid,
          hire: {
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
            // jobId is deliberately not carried onto the wire: the spec's
            // hire object holds only publicly checkable facts, and the
            // internal job id is not one.
            ...(claim.specHash === null ? {} : { specHash: claim.specHash }),
          },
        },
      };

      const key = await Ed25519VerificationKey2020.generate({ seed: issuer.seed, controller: issuer.did });
      key.id = `${issuer.did}#${key.publicKeyMultibase}`;

      const loader = securityLoader();
      loader.addStatic(key.id, {
        '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
        ...key.export({ publicKey: true }),
      });
      loader.addStatic(issuer.did, {
        '@context': 'https://www.w3.org/ns/did/v1',
        id: issuer.did,
        assertionMethod: [key.id],
        verificationMethod: [
          {
            '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
            ...key.export({ publicKey: true }),
          },
        ],
      });
      const documentLoader = loader.build();

      const signed = await vc.issue({
        credential,
        suite: new Ed25519Signature2020({ key }),
        documentLoader,
      });
      return signed as unknown as VerifiableCredential;
    },
    verifyCredential(_credential: VerifiableCredential): Promise<boolean> {
      // Deliberately external (invariant 2) / follow-up, not a service method.
      throw new NotImplementedError(CAPABILITY, 'verifyCredential');
    },
    // Resolve a stored credential by id (R-15): the linked-data bytes the
    // platform stored, verbatim, so the proof still verifies off-platform.
    getCredential: (credentialId: string) => resolveStoredCredential(credentialRepo, credentialId),
  };
}

// The serve-only adapter (R-15): the app's default until R-36 wires
// createCredentialsAdapter's issuer into the merge route. Issuance stays
// honest about itself instead of being silently stubbed out of the type.
export function createCredentialResolver(
  credentialRepo: CredentialRepository = createCredentialRepository(),
): CredentialsAdapter {
  return {
    // Issuance goes through createCredentialsAdapter, which the merge route
    // does not call yet (R-36 wires it in).
    issueWorkHistoryCredential(_subjectDid: string, _claim: WorkHistoryClaim): Promise<VerifiableCredential> {
      throw new NotImplementedError(CAPABILITY, 'issueWorkHistoryCredential');
    },
    verifyCredential(_credential: VerifiableCredential): Promise<boolean> {
      // Same stance as the full adapter: verification belongs to third
      // parties (invariant 2), not to this service.
      throw new NotImplementedError(CAPABILITY, 'verifyCredential');
    },
    getCredential: (credentialId: string) => resolveStoredCredential(credentialRepo, credentialId),
  };
}
