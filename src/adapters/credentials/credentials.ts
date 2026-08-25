import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { NotImplementedError } from '../not-implemented.js';
import { createCredentialRepository } from '../storage/storage.js';
import { CredentialNotFoundError, type CredentialRepository } from '../storage/types.js';
import type { CredentialsAdapter, CredentialsIssuer, VerifiableCredential, WorkHistoryClaim } from './types.js';

const CAPABILITY = 'credentials';

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
// The full adapter: real issuance (R-14) and real resolution (R-15). Used
// by callers that hold the platform issuer; the app's default is
// createCredentialResolver below, until R-13 wires the issuer in.
export function createCredentialsAdapter(
  issuer: CredentialsIssuer,
  credentialRepo: CredentialRepository = createCredentialRepository(),
): CredentialsAdapter {
  return {
    async issueWorkHistoryCredential(subjectDid: string, claim: WorkHistoryClaim): Promise<VerifiableCredential> {
      const credential = {
        '@context': [
          'https://www.w3.org/2018/credentials/v1',
          'https://w3id.org/security/suites/ed25519-2020/v1',
          { '@vocab': 'https://freeagents.dev/terms#' },
        ],
        id: `urn:uuid:${crypto.randomUUID()}`,
        type: ['VerifiableCredential', 'CompletedHireCredential'],
        issuer: issuer.did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: subjectDid, ...claim },
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

// The serve-only adapter (R-15): a deployment that has credential storage
// but has not wired the platform issuer yet (that is R-13's deliverable)
// can still resolve credentials it was handed. Issuance stays honest about
// itself instead of being silently stubbed out of the type.
export function createCredentialResolver(
  credentialRepo: CredentialRepository = createCredentialRepository(),
): CredentialsAdapter {
  return {
    // Issuance needs the platform issuer, which this deployment does not
    // have yet (R-13 wires it in).
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
