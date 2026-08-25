import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { NotImplementedError } from '../not-implemented.js';
import type { CredentialsAdapter, CredentialsIssuer, VerifiableCredential, WorkHistoryClaim } from './types.js';

const CAPABILITY = 'credentials';

// Issuance signs with the W3C-conformant Ed25519Signature2020 suite
// (@digitalbazaar/*), not @arcblock/vc: the ArcBlock suite emits a `jws`
// proof that no standard W3C verifier recognizes, and invariant 2 requires
// that a stranger verify our credentials with an off-the-shelf verifier
// (tests/api/agent-invariant2.test.ts records the jws regression R-2 closed).
// Verification is deliberately left unimplemented: it belongs to third
// parties (invariant 2) and to the follow-up that wires the resolvable
// endpoint, not to this factory.
export function createCredentialsAdapter(issuer: CredentialsIssuer): CredentialsAdapter {
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
    getCredential(_credentialId: string): Promise<VerifiableCredential> {
      throw new NotImplementedError(CAPABILITY, 'getCredential');
    },
  };
}
