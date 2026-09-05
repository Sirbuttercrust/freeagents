// DID resolver for did:abt method. The did:abt DID encodes an address hash,
// not the raw public key, so resolution requires the verificationMethod from
// the credential's proof (which carries the Ed25519 public key fingerprint).
// No network call: the proof itself provides what the resolver needs.
import { createPublicKey } from 'node:crypto';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import { fromPublicKey } from '@arcblock/did';
import type { SigningKeyResolver } from './http-signature.js';
import type { ObservedKeyRepository } from '../storage/types.js';

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

// R-3 + R-4 completion (B5, launch blocker): local-only DID resolution and
// verify need a source for "what verification method does this DID use"
// that is not a network call (invariant 2). The signing-key resolver below
// already performs the one binding check that makes a verificationMethod
// trustworthy: does the public key it names actually re-derive the DID
// that claims it? A KnownKeyStore is exactly the record of DIDs that have
// passed that check during this process's lifetime, so identity.ts's
// resolveDid and verify have real key material to work from without ever
// calling out. This is a real limitation, stated rather than hidden: a DID
// this process has not yet seen a valid signature from cannot be resolved,
// the same honest gap did-abt-resolver.ts already leaves in
// buildDidAbtLoader (it needs the proof's own verificationMethod, not a
// network fetch, to do anything at all).
export interface KnownKeyStore {
  // Records that this DID's key material has been checked, once, against
  // the binding check below. Overwrites any prior entry for the same DID
  // (a later verified signature is the freshest evidence), never merges.
  record(did: string, verificationMethod: string): void;
  // Null when this DID has never passed the binding check in this process.
  get(did: string): string | null;
}

// An in-memory store, module-scoped by whoever constructs it (the app
// wires one instance through createIdentityAdapter and
// createDidAbtSigningKeyResolver so both draw from the same observations).
// No key material here, ever: only the public verificationMethod string
// (did:abt:<suffix>#<fingerprint>), the same shape delegation.proof.
// verificationMethod already carries onto the wire.
export function createKnownKeyStore(): KnownKeyStore {
  const known = new Map<string, string>();
  return {
    record(did, verificationMethod) {
      known.set(did, verificationMethod);
    },
    get(did) {
      return known.get(did) ?? null;
    },
  };
}

// D2 (task t_8a82c865): the durable half of the binding check's memory.
// Optional so every existing caller (tests, and the smoke-test wrapped
// adapter) is unaffected; when supplied, a keyid that passes the binding
// check is recorded here too, so the SAME observation survives a process
// restart, not just this process's lifetime. The anchor (this card): "a
// stranger derives the same verificationMethod from the keyid whether or
// not this process happened to be running when the agent last signed" --
// this is what makes that true for THIS process's own later requests, not
// only for a stranger's independent derivation.
export function createDidAbtSigningKeyResolver(
  isRegistered: (did: string) => Promise<boolean>,
  knownKeys?: KnownKeyStore,
  observedKeys?: ObservedKeyRepository,
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

      // D4/D5 (task t_8a82c865): recording is deferred to onVerified,
      // called by http-signature.ts's verify() only after the request's
      // own signature bytes have checked out -- not here, where only the
      // keyid's binding check (public data) has passed. knownKeys.record
      // is synchronous and in-memory, so it cannot itself fail; it runs
      // before the durable write so a durable-write failure never loses
      // the in-process observation.
      return {
        publicKeyPem,
        async onVerified() {
          knownKeys?.record(did, keyid);
          await observedKeys?.record(did, keyid);
        },
      };
    } catch {
      return null;
    }
  };
}
