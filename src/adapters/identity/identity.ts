import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import * as vc from '@digitalbazaar/vc';
import { didSuffix, type Delegation } from '../../domain/agent.js';
import { NotImplementedError } from '../not-implemented.js';
import { buildDidAbtLoader, createKnownKeyStore, type KnownKeyStore } from './did-abt-resolver.js';
import type { DidDocument, DidKeyPair, IdentityAdapter, SignedPayload } from './types.js';

const CAPABILITY = 'identity';

// Thrown by resolveDid and verify when a DID's key has never been observed
// in this process (KnownKeyStore has no entry). Named rather than a bare
// Error, matching the rest of this codebase's stance (GistNotFoundError,
// AgentAlreadyExistsError): every app.ts call site already maps ANY thrown
// error from these two methods to 503 (identity resolution/verification
// unavailable), so this class exists for callers that want to distinguish
// "never observed" from a genuine bug, not because app.ts requires it today.
export class DidNotResolvableError extends Error {
  constructor(did: string) {
    super(`${did} has not been observed in this process; no verificationMethod can be derived locally`);
    this.name = 'DidNotResolvableError';
  }
}

// Real implementation is @arcblock/did behind this factory. verifyDelegation
// uses W3C Ed25519Signature2020 suite for third-party verifiability (invariant 2):
// the verification uses only the credential itself, no DID resolution and no
// call back to this service. resolveDid and verify follow the identical
// discipline (R-3 + R-4 completion, B5): a DID's verification method is
// derived from key material this process has itself independently checked
// (the R-34 signing-key resolver's binding check, recorded into knownKeys),
// never fetched over a network and never guessed. createOperatorDid,
// createAgentDid and sign stay NotImplementedError: nothing on main calls
// them (grep src/api/app.ts -- neither identity.createOperatorDid,
// identity.createAgentDid nor identity.sign appears there), so building them
// ahead of need would violate FACTORY_RULES.md 2.5.
export function createIdentityAdapter(knownKeys: KnownKeyStore = createKnownKeyStore()): IdentityAdapter {
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
    // R-3 completion (B5): construct the DID document locally from the
    // ONE verification method this process has itself independently
    // observed for this DID (knownKeys, populated by the R-34 signing-key
    // resolver's binding check -- the same discipline buildDidAbtLoader
    // above already applies to a credential's proof). alsoKnownAs is
    // always null here: the real DID document's alsoKnownAs entry (R-3
    // direction one) is authored by the operator's own wallet tooling and
    // is not derivable from key material alone, so this adapter is honest
    // about not knowing it rather than fabricating an empty-but-plausible
    // answer. A DID this process has never seen a valid signature from is
    // a DidNotResolvableError, never a guessed document.
    resolveDid(did: string): Promise<DidDocument> {
      const verificationMethod = knownKeys.get(did);
      if (verificationMethod === null) {
        return Promise.reject(new DidNotResolvableError(did));
      }
      const doc: DidDocument = {
        id: did,
        controller: null,
        verificationMethod: [verificationMethod],
        alsoKnownAs: null,
      };
      return Promise.resolve(doc);
    },
    sign(_did: string, _payload: string): Promise<SignedPayload> {
      throw new NotImplementedError(CAPABILITY, 'sign');
    },
    // R-4 completion (B5): standard ed25519 verification of the payload
    // bytes against the signature, using the public key derived from the
    // signer's OWN observed verification method (knownKeys) -- node:crypto,
    // no network call (invariant 2). Total on a bad signature (returns
    // false, matching verifyDelegation's stance); only an unresolvable
    // signerDid throws, the same "no data to work from" case resolveDid
    // above throws on.
    async verify(signed: SignedPayload): Promise<boolean> {
      const verificationMethod = knownKeys.get(signed.signerDid);
      if (verificationMethod === null) {
        throw new DidNotResolvableError(signed.signerDid);
      }
      const fragment = verificationMethod.slice(verificationMethod.indexOf('#') + 1);
      const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: fragment });
      const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
        format: 'jwk',
      });
      try {
        return nodeVerify(
          null,
          Buffer.from(signed.payload, 'utf8'),
          publicKey,
          Buffer.from(signed.signature, 'base64'),
        );
      } catch {
        // A malformed signature (wrong length, bad base64) is a "no", the
        // same stance signatureIsWellFormed's callers already take
        // upstream -- never a 503 for garbage input.
        return false;
      }
    },
  };
}
