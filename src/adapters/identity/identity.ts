import { create as createCredential, verify as verifyCredential } from '@arcblock/vc';
import { didSuffix, type Delegation } from '../../domain/agent.js';
import { NotImplementedError } from '../not-implemented.js';
import type { DidDocument, DidKeyPair, IdentityAdapter, SignedPayload } from './types.js';

const CAPABILITY = 'identity';

// @arcblock/vc does not export its credential type, only its functions;
// create's return type is the very thing verify expects, so that is where
// it comes from.
type Credential = NonNullable<Awaited<ReturnType<typeof createCredential>>>;

// Real implementation is @arcblock/did behind this factory. Until then every
// method throws, which is honest: there is no in-memory stand-in for DID
// cryptography that would not be misleading to build against. verifyDelegation
// is the one real method (R-2): the proof already carries the issuer's public
// key, so @arcblock/vc verifies it offline, no DID resolution and no call
// back to this service. That offline property is what invariant 2 needs.
export function createIdentityAdapter(): IdentityAdapter {
  return {
    createOperatorDid(): Promise<DidKeyPair> {
      throw new NotImplementedError(CAPABILITY, 'createOperatorDid');
    },
    // The vendor signs proofs with the wallet's short-form address (z...),
    // while the registry records the full DID (did:abt:z...), so the trusted
    // list carries both forms of the operator DID. The vendor throws on any
    // shape it does not recognise; a rejected proof is false, not an error.
    async verifyDelegation(delegation: Delegation, ownerDid: string, issuerDid: string): Promise<boolean> {
      try {
        const ok = await verifyCredential({
          vc: delegation as unknown as Credential,
          ownerDid,
          trustedIssuers: [issuerDid, didSuffix(issuerDid)],
        });
        return ok === true;
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
