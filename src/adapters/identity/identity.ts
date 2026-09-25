import { createPublicKey, hkdfSync, verify as nodeVerify } from 'node:crypto';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import * as vc from '@digitalbazaar/vc';
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { fromPublicKey } from '@arcblock/did';
import { didSuffix, type Delegation } from '../../domain/agent.js';
import { NotImplementedError } from '../not-implemented.js';
import { isValidPlatformSeedHex } from '../credentials/credentials.js';
import type { ObservedKeyRepository } from '../storage/types.js';
import { deriveDidFromSeed } from './did-from-seed.js';
import { buildDidAbtLoader, createKnownKeyStore, type KnownKeyStore } from './did-abt-resolver.js';
import type { DidDocument, DidKeyPair, IdentityAdapter, SignedPayload } from './types.js';

const CAPABILITY = 'identity';

// P8d: thrown when FREEAGENTS_PLATFORM_SEED is unset or malformed at the
// moment a provisioning derivation is attempted. Named rather than a bare
// Error so app.ts can map it to 503 without inspecting the message, the
// same stance every other adapter failure in this file already takes.
export class PlatformSeedUnavailableError extends Error {
  constructor() {
    super('FREEAGENTS_PLATFORM_SEED is not set (or is not 64 hex characters); cannot derive an operator DID');
    this.name = 'PlatformSeedUnavailableError';
  }
}

// P8d: the HKDF info string that names this exact use of the platform
// seed. HKDF's info parameter is what keeps two different derivations
// from the same seed from ever landing on the same output: this string
// must never be reused for another purpose (an agent DID, a signing key,
// anything else), or a collision between two unrelated derivations
// becomes possible in principle.
const OPERATOR_DID_HKDF_INFO = 'freeagents:operator-did:v1';
const ED25519_SEED_LENGTH = 32;

// Thrown by resolveDid and verify when a DID's key has never been observed
// in this process (KnownKeyStore has no entry). Named rather than a bare
// Error, matching the rest of this codebase's stance (GistNotFoundError,
// AgentAlreadyExistsError). Callers map it differently depending on whether
// the caller could have supplied a candidate key: resolveDid has no such
// caller (POST /jobs/:jobId/merge maps it to 503, a platform failure), while
// account-proof's verify() call maps it to 409 naming the key-line remedy,
// because the operator could add a `key` line to the gist and resolve it.
export class DidNotResolvableError extends Error {
  constructor(did: string) {
    super(`${did} has not been observed in this process; no verificationMethod can be derived locally`);
    this.name = 'DidNotResolvableError';
  }
}

// PRF1 r1 (Proof review round 1, defect 1 and 2): verify() throws this,
// distinct from DidNotResolvableError, exactly when a caller offered a
// candidate key and the binding check rejected it (malformed, or it derives
// some other DID) and the observed-key store had nothing to fall back on
// either. The account-proof route keeps the two apart because they carry
// different remedies, not because only one is operator-actionable: a
// rejected candidate means fix the existing `key` line, while an absent
// candidate on an unobserved DID means add one (DidNotResolvableError keeps
// that meaning unchanged).
export class CandidateKeyRejectedError extends Error {
  constructor(did: string) {
    super(`the candidate key offered for ${did} does not derive that DID, and no other key has been observed for it`);
    this.name = 'CandidateKeyRejectedError';
  }
}

// Real implementation is @arcblock/did behind this factory. verifyDelegation
// uses W3C Ed25519Signature2020 suite for third-party verifiability (invariant 2):
// the verification uses only the credential itself, no DID resolution and no
// call back to this service. resolveDid and verify follow the identical
// discipline (R-3 + R-4 completion, B5): a DID's verification method is
// derived from key material this process has itself independently checked
// (the R-34 signing-key resolver's binding check, recorded into knownKeys),
// never fetched over a network and never guessed. createOperatorDid is a
// real implementation as of P8d (auto-provisioning at first sign-in needs
// it); createAgentDid and sign stay NotImplementedError: nothing on main
// calls them (grep src/api/app.ts -- neither identity.createAgentDid nor
// identity.sign appears there), so building them ahead of need would
// violate FACTORY_RULES.md 2.5.
export function createIdentityAdapter(
  knownKeys: KnownKeyStore = createKnownKeyStore(),
  observedKeys?: ObservedKeyRepository,
): IdentityAdapter {
  // D2 (task t_8a82c865): the in-process KnownKeyStore first (no I/O, the
  // common case), the durable ObservedKeyRepository second, so a DID this
  // process observed before a restart still resolves without a network
  // call -- the anchor's own words, made true across process restarts and
  // not only for a stranger's independent derivation.
  async function resolveVerificationMethod(did: string): Promise<string | null> {
    const inProcess = knownKeys.get(did);
    if (inProcess !== null) return inProcess;
    return (await observedKeys?.get(did)) ?? null;
  }
  return {
    // P8d: derives a real ed25519 keypair from FREEAGENTS_PLATFORM_SEED
    // and `subject` via HKDF (node:crypto, no network, no new
    // dependency), then builds the did:abt value with @arcblock/did's own
    // fromPublicKey -- the same call did-abt-resolver.ts and
    // tests/helpers/sign-request.ts already use, so this never hand-rolls
    // the address encoding. Deterministic: the same subject always
    // derives the same 32-byte seed and therefore the same DID, which is
    // the property that makes signing in twice never mint a second
    // account. No private key is stored anywhere; only the derived
    // public key and DID are returned, and the secret stays
    // re-derivable from the seed and the subject alone.
    async createOperatorDid(subject: string): Promise<DidKeyPair> {
      const hex = process.env.FREEAGENTS_PLATFORM_SEED;
      if (hex === undefined || !isValidPlatformSeedHex(hex)) {
        throw new PlatformSeedUnavailableError();
      }
      const seedBytes = Buffer.from(hex.replace(/^0x/i, ''), 'hex');
      const derived = hkdfSync('sha256', seedBytes, '', `${OPERATOR_DID_HKDF_INFO}:${subject}`, ED25519_SEED_LENGTH);
      const { did, publicKeyMultibase } = await deriveDidFromSeed(new Uint8Array(derived));
      return { did, publicKeyMultibase };
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
    // always undefined here, never null: the real DID document's
    // alsoKnownAs entry (R-3 direction one) is authored by the operator's
    // own wallet tooling and is not derivable from key material alone, so
    // this adapter has no path to check it at all. undefined says exactly
    // that ("cannot determine"), which the account-proof route maps to a
    // 503; null would claim "checked, no claim present" and hand back a
    // 409 whose remedy the operator can never make this adapter observe
    // (Review finding, round 1, D1, task t_8a82c865: a permanent, unsatisfiable
    // conflict is worse than the outage it replaced). A DID this process
    // has never seen a valid signature from is a DidNotResolvableError,
    // never a guessed document.
    resolveDid(did: string): Promise<DidDocument> {
      return resolveVerificationMethod(did).then((verificationMethod) => {
        if (verificationMethod === null) {
          throw new DidNotResolvableError(did);
        }
        const doc: DidDocument = {
          id: did,
          controller: null,
          verificationMethod: [verificationMethod],
          alsoKnownAs: undefined,
        };
        return doc;
      });
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
    //
    // PRF1 (bugs.md B31): a caller may also pass candidateKeyMultibase --
    // the gist statement's own optional key line -- naming a key it
    // believes is signerDid's. This closes the defect where a brand-new
    // agent's first proof answered 503 because resolveVerificationMethod
    // only ever learns a key from a PRIOR signed request from that same
    // key (the onVerified path in http-signature.ts): a fresh agent that
    // has never sent one had nothing to resolve, even with a perfectly
    // valid signature in hand. The candidate is trusted only after the
    // SAME binding check buildDidAbtLoader and the R-34 signing-key
    // resolver already apply to every other key this service accepts: the
    // public key must itself derive signerDid via did:abt's own encoding
    // (fromPublicKey), never taken on the caller's word. A candidate that
    // fails that check (malformed, or derives some other DID) falls back
    // to the observed-key store exactly as before, so a well-behaved
    // caller who simply omits the field sees no change at all.
    //
    // PRF1 r1 (Proof review round 1, defect 2): when the fallback ALSO has
    // nothing, the two ways of getting here are told apart. A caller who
    // offered a candidate and had it rejected gets CandidateKeyRejectedError:
    // the gist is public and operator-authored, so naming the bad line back
    // is an operator-fixable conflict, not a platform outage. A caller who
    // offered no candidate at all keeps the original DidNotResolvableError.
    // Neither path is a security downgrade: the rejection already happened
    // inside candidateVerificationMethod's binding check before this branch
    // runs, so nothing here lets an unbound key through.
    async verify(signed: SignedPayload): Promise<boolean> {
      const candidate = signed.candidateKeyMultibase;
      const candidateOffered = typeof candidate === 'string' && candidate.length > 0;
      let verificationMethod: string | null = null;
      if (candidateOffered) {
        verificationMethod = await candidateVerificationMethod(signed.signerDid, candidate);
      }
      const candidateRejected = candidateOffered && verificationMethod === null;
      if (verificationMethod === null) {
        verificationMethod = await resolveVerificationMethod(signed.signerDid);
      }
      if (verificationMethod === null) {
        if (candidateRejected) {
          throw new CandidateKeyRejectedError(signed.signerDid);
        }
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

// PRF1 (bugs.md B31): the binding check a candidate key must pass before
// verify() above will use it -- does the key's OWN derived DID equal the
// DID the caller claims it belongs to? Identical in substance to
// buildDidAbtLoader's binding check (did-abt-resolver.ts) and the R-34
// signing-key resolver's own fromPublicKey comparison: never a new rule,
// the same one this service already applies to every other key it accepts.
// Total: any malformed fingerprint or non-matching derivation is null, the
// caller's cue to fall back to the observed-key store, never a throw.
async function candidateVerificationMethod(did: string, candidateKeyMultibase: string): Promise<string | null> {
  try {
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: candidateKeyMultibase });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;
    if (raw.length !== 32) return null;
    if (fromPublicKey(raw) !== did.replace(/^did:abt:/, '')) return null;
    return `${did}#${candidateKeyMultibase}`;
  } catch {
    return null;
  }
}
