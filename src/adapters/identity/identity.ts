import { NotImplementedError } from '../not-implemented.js';
import type { DidDocument, DidKeyPair, IdentityAdapter, SignedPayload } from './types.js';

const CAPABILITY = 'identity';

// Real implementation is @arcblock/did behind this factory. Until then every
// method throws, which is honest: there is no in-memory stand-in for DID
// cryptography that would not be misleading to build against.
export function createIdentityAdapter(): IdentityAdapter {
  return {
    createOperatorDid(): Promise<DidKeyPair> {
      throw new NotImplementedError(CAPABILITY, 'createOperatorDid');
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
