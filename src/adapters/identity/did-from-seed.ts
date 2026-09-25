// The one derivation both createOperatorDid (identity.ts) and
// platformIssuerFromEnv (credentials.ts) share, so an operator DID and the
// platform's own issuer DID can never drift onto two different encodings
// of the same key material. did:abt is derived from the raw ed25519 public
// key through @arcblock/did's own fromPublicKey, never a hand-rolled
// address encoding -- the exact call did-abt-resolver.ts's binding check
// already uses to go the other direction (key -> claimed DID).
import { fromPublicKey } from '@arcblock/did';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';

export interface DerivedDid {
  readonly did: string;
  readonly publicKeyMultibase: string;
}

// The suite requires a controller at generate time; a placeholder stands
// in because the DID is itself derived from this key a moment later.
export async function deriveDidFromSeed(seed: Uint8Array): Promise<DerivedDid> {
  const key = await Ed25519VerificationKey2020.generate({ seed, controller: 'did:abt:pending' });
  const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
  if (key.publicKeyMultibase === undefined) {
    throw new Error('deriveDidFromSeed: key generation did not produce a publicKeyMultibase');
  }
  return {
    did: `did:abt:${fromPublicKey(raw)}`,
    publicKeyMultibase: key.publicKeyMultibase,
  };
}
