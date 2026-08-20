import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import * as vc from '@digitalbazaar/vc';
import { didSuffix, type Delegation } from '../../domain/agent.js';
import { NotImplementedError } from '../not-implemented.js';
import { buildDidAbtLoader } from './did-abt-resolver.js';
import type { DidDocument, DidKeyPair, IdentityAdapter, SignedPayload } from './types.js';

const CAPABILITY = 'identity';

// Real implementation is @arcblock/did behind this factory. Until then every
// method throws, which is honest: there is no in-memory stand-in for DID
// cryptography that would not be misleading to build against. verifyDelegation
// uses W3C Ed25519Signature2020 suite for third-party verifiability (invariant 2):
// the verification uses only the credential itself, no DID resolution and no
// call back to this service.
export function createIdentityAdapter(): IdentityAdapter {
  return {
    createOperatorDid(): Promise<DidKeyPair> {
      throw new NotImplementedError(CAPABILITY, 'createOperatorDid');
    },
    // Verify a W3C Verifiable Credential with Ed25519Signature2020 proof.
    // The proof type and proofValue presence are already checked in
    // delegationConsistent; this handles the cryptographic verification.
    // Uses a did:abt resolver that extracts the public key from the DID
    // itself, so verification needs no network call (invariant 2).
    async verifyDelegation(delegation: Delegation, ownerDid: string, issuerDid: string): Promise<boolean> {
      try {
        // The credential's subject must match ownerDid.
        if (delegation.credentialSubject.id !== ownerDid &&
            didSuffix(delegation.credentialSubject.id) !== didSuffix(ownerDid)) {
          return false;
        }
        // The issuer must match issuerDid (allow both full and short form).
        if (delegation.issuer !== issuerDid &&
            didSuffix(delegation.issuer) !== didSuffix(issuerDid)) {
          return false;
        }

        // Build a document loader that can resolve did:abt DIDs. The public key
        // fingerprint is in proof.verificationMethod, not derivable from the DID
        // alone (did:abt encodes an address hash, not the raw key). No network call.
        const verificationMethod = typeof delegation.proof.verificationMethod === 'string'
          ? delegation.proof.verificationMethod
          : '';
        const documentLoader = await buildDidAbtLoader(issuerDid, verificationMethod);

        const suite = new Ed25519Signature2020();
        const result = await vc.verifyCredential({
          credential: delegation,
          suite,
          documentLoader,
        });
        return result.verified === true;
      } catch {
        return false;
      }
    },
    createAgentDid(_operatorDid: string): Promise<DidKeyPair> {
      throw new NotImplementedError(CAPABILITY, 'createAgentDid');
    },
    resolveDid(_did: string): Promise<DidDocument> {
      throw new NotImplementedError(CAPABILITY, 'resolveDid');
    },
    sign(_did: string, _payload: string): Promise<SignedPayload> {
      throw new NotImplementedError(CAPABILITY, 'sign');
    },
    verify(_signed: SignedPayload): Promise<boolean> {
      throw new NotImplementedError(CAPABILITY, 'verify');
    },
  };
}
