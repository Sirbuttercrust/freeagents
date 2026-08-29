// DID resolver for did:abt method. The did:abt DID encodes an address hash,
// not the raw public key, so resolution requires the verificationMethod from
// the credential's proof (which carries the Ed25519 public key fingerprint).
// No network call: the proof itself provides what the resolver needs.
import { createPublicKey } from 'node:crypto';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromPublicKey } from '@arcblock/did';
import type { SigningKeyResolver } from './http-signature.js';

// Ed25519VerificationKey2020 has a private _publicKeyBuffer property that holds
// the raw public key bytes. This interface extends the public type to access it.
interface Ed25519KeyWithBuffer extends Ed25519VerificationKey2020 {
  _publicKeyBuffer: Uint8Array;
}

// Build a document loader that can resolve did:abt DIDs. The proof's
// verificationMethod (e.g., did:abt:z...#z6Mk...) carries the Ed25519 public
// key fingerprint in its fragment. Extract it, reconstruct the key, and build
// a document loader. No network call: the credential carries everything needed.
export async function buildDidAbtLoader(issuerDid: string, verificationMethod: string) {
  // The verificationMethod is like did:abt:z1...#z6Mk... where the fragment
  // is the Ed25519 public key fingerprint (z6M prefix = ed25519-pub multicodec).
  const hashIndex = verificationMethod.indexOf('#');
  if (hashIndex === -1) {
    throw new Error('verificationMethod must have a fragment (#z6Mk...)');
  }
  const fingerprint = verificationMethod.slice(hashIndex + 1);

  // Reconstruct the Ed25519 key from the fingerprint.
  const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint });

  // BINDING CHECK: verify the key actually belongs to the claimed issuer DID.
  // An attacker could sign with their own key and write
  // <victim-did>#<attacker-fingerprint> into verificationMethod. The signature
  // would verify correctly against the attacker's own key, but the key does
  // not belong to the victim. Derive the DID from the public key and require
  // it to match the claimed issuer BEFORE trusting this key for verification.
  const keyWithBuffer = key as Ed25519KeyWithBuffer;
  const derivedDidSuffix = fromPublicKey(keyWithBuffer._publicKeyBuffer);
  const issuerSuffix = issuerDid.replace(/^did:abt:/, '');

  if (derivedDidSuffix !== issuerSuffix) {
    throw new Error('verificationMethod key does not belong to the claimed issuer DID');
  }

  key.controller = issuerDid;
  key.id = verificationMethod;

  const loader = securityLoader();

  // Add static mappings for this DID's key and DID document.
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

  return loader.build();
}

// Signing-key resolver for RFC 9421 request signatures (R-34). Given a
// keyid of the form did:abt:<suffix>#<multibase-fingerprint>, reconstruct
// the ed25519 public key from the fingerprint and require it to re-derive
// the claimed DID suffix -- the same binding check as buildDidAbtLoader
// above, applied to a bare request signature rather than a VC proof.
export function createDidAbtSigningKeyResolver(
  isRegistered: (did: string) => Promise<boolean>,
): SigningKeyResolver {
  return async (did, keyid) => {
    try {
      if (!(await isRegistered(did))) return null;

      const fragment = keyid.slice(keyid.indexOf('#') + 1);
      if (!fragment) return null;

      const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: fragment });
      const raw = (key as Ed25519KeyWithBuffer)._publicKeyBuffer;
      if (raw.length !== 32) return null;

      if (fromPublicKey(raw) !== did.replace(/^did:abt:/, '')) return null;

      const publicKeyPem = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
        format: 'jwk',
      }).export({ type: 'spki', format: 'pem' }) as string;

      return { publicKeyPem };
    } catch {
      return null;
    }
  };
}
