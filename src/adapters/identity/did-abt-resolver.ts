// DID resolver for did:abt method. The did:abt DID encodes an address hash,
// not the raw public key, so resolution requires the verificationMethod from
// the credential's proof (which carries the Ed25519 public key fingerprint).
// No network call: the proof itself provides what the resolver needs.
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';

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
