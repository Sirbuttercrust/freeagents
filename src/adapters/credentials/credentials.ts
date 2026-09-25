import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { securityLoader } from '@digitalbazaar/security-document-loader';
import * as vc from '@digitalbazaar/vc';
import { type Attestation } from '../../domain/attestation.js';
import { NotImplementedError } from '../not-implemented.js';
import { deriveDidFromSeed } from '../identity/did-from-seed.js';
import { createCredentialRepository } from '../storage/storage.js';
import { CredentialNotFoundError, type CredentialRepository } from '../storage/types.js';
import type {
  CredentialsAdapter,
  CredentialsIssuer,
  DeemedCompletionClaim,
  DeemedCompletionCredential,
  IssuedCredentialDocument,
  IssuerDescription,
  SignedAttestation,
  VerifiableCredential,
  WorkHistoryClaim,
} from './types.js';

const CAPABILITY = 'credentials';
// Generic default, no real deployment hostname in a committed file
// (invariant 10; CLAUDE.md "This repository is public"). Matches the PORT
// default the app already ships with.
const DEFAULT_PUBLIC_BASE_URL = 'http://localhost:3000';

// Shape check for FREEAGENTS_PLATFORM_SEED, shared with the P9 startup
// configuration report (report.ts): "configured" must mean the same thing
// in both places, so the report never claims a seed is set when it is a
// value platformIssuerFromEnv would reject and fall back away from. An
// empty string fails this the same as any other malformed value, since
// regex length 64 never matches length 0.
export function isValidPlatformSeedHex(value: string): boolean {
  return /^(0x)?[0-9a-f]{64}$/i.test(value);
}

// Mirrors the storage factory's stance (storage.ts:12-17): an unconfigured
// deployment announces itself rather than pretending to be configured. A
// missing or malformed seed still returns a usable issuer (dev/test mode)
// but the credentials it signs will not verify past this process's
// lifetime, since the seed backing the proof is thrown away on restart.
//
// ISS1 (bugs.md B30): the issuer DID is ALWAYS derived from this key,
// through the exact same call createOperatorDid uses (did-from-seed.ts's
// deriveDidFromSeed), never configured. A verifier holding only the
// credential can already derive did:abt from the key named in
// proof.verificationMethod (did-abt-resolver.ts's own binding check); this
// makes the issuer field itself pass that identical check, rather than
// naming a string no key on earth derives.
export async function platformIssuerFromEnv(): Promise<CredentialsIssuer> {
  const hex = process.env.FREEAGENTS_PLATFORM_SEED;
  // FREEAGENTS_PLATFORM_DID no longer selects anything; it is read only to
  // warn once if a deployment still sets it, naming the DID actually in
  // effect. `||` and not `??`: Blocklet Server materialises every declared
  // env var, so an unconfigured deployment delivers '' rather than
  // undefined, and the nullish check would warn on an unset deployment too.
  const ignoredConfiguredDid = process.env.FREEAGENTS_PLATFORM_DID || '';
  const seed =
    hex !== undefined && isValidPlatformSeedHex(hex)
      ? Uint8Array.from(Buffer.from(hex.replace(/^0x/i, ''), 'hex'))
      : (() => {
          console.warn(
            'credentials: FREEAGENTS_PLATFORM_SEED is not set (or is not 64 hex characters); ' +
              'issuing with a random ephemeral key. Credentials issued now will not verify after ' +
              'a restart. This is a dev/test mode, not production issuance.'
          );
          return crypto.getRandomValues(new Uint8Array(32));
        })();
  const { did } = await deriveDidFromSeed(seed);
  if (ignoredConfiguredDid !== '') {
    console.warn(
      `credentials: FREEAGENTS_PLATFORM_DID is set but is no longer used; the issuer DID is always ` +
        `derived from FREEAGENTS_PLATFORM_SEED. The DID in effect is ${did}.`
    );
  }
  return { did, seed };
}

// The origin a credential id resolves against. ENT-8 (spec/entities.md:208)
// requires the id be stable and resolvable, so it has to be rooted at the
// address a third party can actually reach.
export function publicBaseUrlFromEnv(): string {
  // `||` and not `??`, for the same reason platformIssuerFromEnv gives above:
  // Blocklet Server materialises every declared env var, so an unconfigured
  // deployment delivers '' rather than undefined, and the nullish fallback
  // would mint credential ids rooted at the empty string.
  const configured = (process.env.FREEAGENTS_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
  // A base of '/' strips to '', which is the same defect by another route.
  return configured === '' ? DEFAULT_PUBLIC_BASE_URL : configured;
}

// The serve half, shared by both factories: resolve a stored credential by
// its id (R-15). The repository normalizes the id to its lookup key; a
// missing credential is the domain error the API maps to 404.
async function resolveStoredCredential(
  credentialRepo: CredentialRepository,
  credentialId: string,
): Promise<IssuedCredentialDocument> {
  const document = await credentialRepo.findByDocumentId(credentialId);
  if (document === null) {
    throw new CredentialNotFoundError(credentialId);
  }
  return document;
}

// ISS1 (bugs.md B30): the public description of the issuer, for
// GET /.well-known/freeagents-issuer.json. Derives the SAME key
// signWithPlatformKey below signs with (Ed25519VerificationKey2020.generate
// from issuer.seed with issuer.did as controller), so the published
// verificationMethod is provably the one every issued credential's
// proof.verificationMethod actually names.
async function describeIssuerFromKey(issuer: CredentialsIssuer): Promise<IssuerDescription> {
  const key = await Ed25519VerificationKey2020.generate({ seed: issuer.seed, controller: issuer.did });
  if (key.publicKeyMultibase === undefined) {
    throw new Error('describeIssuerFromKey: key generation did not produce a publicKeyMultibase');
  }
  return {
    issuer: issuer.did,
    verificationMethod: `${issuer.did}#${key.publicKeyMultibase}`,
    publicKeyMultibase: key.publicKeyMultibase,
  };
}

// Shared by issueWorkHistoryCredential and signAttestation: the one
// Ed25519Signature2020 proof construction this service signs with (P5's
// brief: "do not create a second key, a second seed environment variable,
// or a second signing implementation"). Registers the issuer's key and DID
// document statically so the same process that signs can also verify its
// own output, exactly as jsigs.sign requires a document loader either way.
async function signWithPlatformKey(
  issuer: CredentialsIssuer,
  credential: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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

  return (await vc.issue({
    credential,
    suite: new Ed25519Signature2020({ key }),
    documentLoader,
  })) as unknown as Record<string, unknown>;
}

// P5: the platform signature over an attestation (design record,
// 2026-09-01). The id is rooted at the staged commit, not a random nonce,
// for the same ENT-8 reason the work-history credential id is rooted at
// the job id (see issueWorkHistoryCredential's own comment on R-40): a
// stranger holding the attestation can recompute this id from its own
// stagedCommit field, without calling this service. The subject carries
// no buyer/agent DID (an attestation is not about a party's identity, it
// is a measurement of a commit), so credentialSubject.id names the staged
// commit itself through a urn, and credentialSubject.attestation carries
// the Attestation verbatim -- the exact accepted-field document
// buildAttestation produced, nothing added, nothing removed.
async function signAttestationDocument(
  issuer: CredentialsIssuer,
  publicBaseUrl: string,
  attestation: Attestation,
): Promise<SignedAttestation> {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const credential = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `${base}/v1/attestations/${attestation.stagedCommit}`,
    type: ['VerifiableCredential', 'JobAttestation'],
    issuer: issuer.did,
    validFrom: new Date().toISOString(),
    credentialSubject: {
      id: `urn:freeagents:staged-commit:${attestation.stagedCommit}`,
      // The full Attestation object rides here verbatim: it already
      // carries exactly the accepted fields and nothing else
      // (src/domain/attestation.ts), so nothing is re-derived or
      // re-summarized on the way to the wire.
      attestation,
    },
  };
  const signed = await signWithPlatformKey(issuer, credential);
  return signed as unknown as SignedAttestation;
}

// P6 (design record, 2026-09-01, row 3): the distinct deemed-completion
// credential deemCompleted's own header comment calls "a later card's
// job". The id is rooted at the job id, the same R-40 stance
// issueWorkHistoryCredential's own comment takes for a work-history
// credential -- one resolution route serves both types (P5's brief drew
// this line, restated here: never a second signing path or a second
// key). type carries 'DeemedCompletionCredential', never
// 'CompletedHireCredential': a verifier must be able to tell the two
// apart from the type array alone. credentialSubject.deemedCompletion.
// noMerge is a literal `true`, a present positive field, never an
// omission a reader might miss.
async function signDeemedCompletionDocument(
  issuer: CredentialsIssuer,
  publicBaseUrl: string,
  subjectDid: string,
  claim: DeemedCompletionClaim,
): Promise<DeemedCompletionCredential> {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const credential = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/security/suites/ed25519-2020/v1',
      { '@vocab': 'https://freeagents.dev/terms#' },
    ],
    id: `${base}/v1/credentials/${claim.jobId}`,
    type: ['VerifiableCredential', 'DeemedCompletionCredential'],
    issuer: issuer.did,
    validFrom: new Date().toISOString(),
    credentialSubject: {
      id: subjectDid,
      deemedCompletion: {
        stagedCommit: claim.stagedCommit,
        noMerge: true as const,
        buyer: claim.buyerDid,
      },
    },
  };
  const signed = await signWithPlatformKey(issuer, credential);
  return signed as unknown as DeemedCompletionCredential;
}

// Issuance signs with the W3C-conformant Ed25519Signature2020 suite
// (@digitalbazaar/*), not @arcblock/vc: the ArcBlock suite emits a `jws`
// proof that no standard W3C verifier recognizes, and invariant 2 requires
// that a stranger verify our credentials with an off-the-shelf verifier
// (tests/api/agent-invariant2.test.ts records the jws regression R-2 closed).
// Verification is deliberately left unimplemented: it belongs to third
// parties (invariant 2), not to this factory. Resolution (R-15) is real:
// the adapter serves the bytes it was given.
//
// The full adapter: real issuance (R-14, widened to the hire wire shape by
// R-35) and real resolution (R-15). The issuer defaults to the env-derived
// platform issuer (platformIssuerFromEnv above); the app's default for
// serving without issuing is createCredentialResolver below, until R-36
// wires this adapter into the merge route.
//
// platformIssuerFromEnv is async (deriving a DID from the seed's public key
// takes an await), so the default cannot be evaluated as a plain default
// parameter the way it used to be. Instead the resolution is a single
// memoized promise per factory call: every signing path below awaits the
// SAME promise, so all credentials this adapter instance issues carry the
// identical issuer, and platformIssuerFromEnv's console.warn calls fire at
// most once no matter how many credentials get issued.
export function createCredentialsAdapter(
  issuer?: CredentialsIssuer,
  credentialRepo: CredentialRepository = createCredentialRepository(),
  publicBaseUrl: string = publicBaseUrlFromEnv(),
): CredentialsAdapter {
  const issuerPromise: Promise<CredentialsIssuer> =
    issuer !== undefined ? Promise.resolve(issuer) : platformIssuerFromEnv();
  // Stripped here too, not only inside publicBaseUrlFromEnv's default path:
  // a caller (a test, a future config source) may pass this argument
  // directly, and the id must not double its separator either way.
  const base = publicBaseUrl.replace(/\/+$/, '');
  return {
    async issueWorkHistoryCredential(subjectDid: string, claim: WorkHistoryClaim): Promise<VerifiableCredential> {
      const resolvedIssuer = await issuerPromise;
      const credential = {
        '@context': [
          'https://www.w3.org/ns/credentials/v2',
          'https://w3id.org/security/suites/ed25519-2020/v1',
          { '@vocab': 'https://freeagents.dev/terms#' },
        ],
        // R-40: the credential id IS the resolution handle, not a random
        // nonce. ENT-8 requires it stable and resolvable, and storage keys
        // every credential on the completed job id (credentialLookupKey,
        // adapters/storage/types.ts), so the urn:uuid this used to mint
        // resolved nowhere: GET /v1/credentials/:id answered 404 for a
        // credential this platform issued itself.
        //
        // The job id appears HERE and deliberately NOT in credentialSubject.hire
        // below. An id is an address and a claim field is an assertion, and only
        // the second is governed by "publicly checkable facts only". Two fields,
        // two rules; they are not in conflict.
        id: `${base}/v1/credentials/${claim.jobId}`,
        type: ['VerifiableCredential', 'CompletedHireCredential'],
        issuer: resolvedIssuer.did,
        validFrom: new Date().toISOString(),
        credentialSubject: {
          id: subjectDid,
          hire: {
            brief: claim.briefHash,
            repository: claim.repository,
            pullRequest: claim.pullRequestUrl,
            mergedAt: claim.mergedAt,
            mergeCommit: claim.mergeCommitSha,
            signedBy: claim.signedBy,
            buyer: claim.buyerDid,
            additions: claim.diffAdditions,
            deletions: claim.diffDeletions,
            filesChanged: claim.diffFiles,
            // jobId is deliberately not carried onto the wire: the spec's
            // hire object holds only publicly checkable facts, and the
            // internal job id is not one. It does appear in the credential's
            // `id` above, which is the resolution handle ENT-8 requires and a
            // different field with a different rule (R-40).
            ...(claim.specHash === null ? {} : { specHash: claim.specHash }),
          },
        },
      };

      const signed = await signWithPlatformKey(resolvedIssuer, credential);
      return signed as unknown as VerifiableCredential;
    },
    verifyCredential(_credential: VerifiableCredential): Promise<boolean> {
      // Deliberately external (invariant 2) / follow-up, not a service method.
      throw new NotImplementedError(CAPABILITY, 'verifyCredential');
    },
    // Resolve a stored credential by id (R-15): the linked-data bytes the
    // platform stored, verbatim, so the proof still verifies off-platform.
    getCredential: (credentialId: string) => resolveStoredCredential(credentialRepo, credentialId),
    // P5: sign an attestation with the same platform key and the same
    // Ed25519Signature2020 construction issuance already uses above.
    signAttestation: async (attestation: Attestation) =>
      signAttestationDocument(await issuerPromise, base, attestation),
    // P6: the distinct deemed-completion credential, same platform key,
    // same Ed25519Signature2020 construction as every other issuance path
    // in this factory.
    issueDeemedCompletionCredential: async (subjectDid: string, claim: DeemedCompletionClaim) =>
      signDeemedCompletionDocument(await issuerPromise, base, subjectDid, claim),
    // ISS1 (bugs.md B30): the well-known route's data source, resolved
    // from the SAME issuerPromise every signing path above awaits, so the
    // published key is provably the signing key.
    describeIssuer: async () => describeIssuerFromKey(await issuerPromise),
  };
}

// The serve-only adapter (R-15): the app's default until R-36 wires
// createCredentialsAdapter's issuer into the merge route. Issuance stays
// honest about itself instead of being silently stubbed out of the type.
export function createCredentialResolver(
  credentialRepo: CredentialRepository = createCredentialRepository(),
): CredentialsAdapter {
  return {
    // Issuance goes through createCredentialsAdapter, which the merge route
    // does not call yet (R-36 wires it in).
    issueWorkHistoryCredential(_subjectDid: string, _claim: WorkHistoryClaim): Promise<VerifiableCredential> {
      throw new NotImplementedError(CAPABILITY, 'issueWorkHistoryCredential');
    },
    verifyCredential(_credential: VerifiableCredential): Promise<boolean> {
      // Same stance as the full adapter: verification belongs to third
      // parties (invariant 2), not to this service.
      throw new NotImplementedError(CAPABILITY, 'verifyCredential');
    },
    getCredential: (credentialId: string) => resolveStoredCredential(credentialRepo, credentialId),
    // Same stance as issueWorkHistoryCredential above: signing goes through
    // createCredentialsAdapter, which the stage route calls (see
    // src/api/app.ts); this serve-only adapter never signs.
    signAttestation(_attestation: Attestation): Promise<SignedAttestation> {
      throw new NotImplementedError(CAPABILITY, 'signAttestation');
    },
    // Same stance again: issuance goes through createCredentialsAdapter,
    // which the deemed-completion issuance path calls (see src/api/app.ts).
    issueDeemedCompletionCredential(_subjectDid: string, _claim: DeemedCompletionClaim): Promise<DeemedCompletionCredential> {
      throw new NotImplementedError(CAPABILITY, 'issueDeemedCompletionCredential');
    },
    // Same stance again: this serve-only adapter carries no signing key at
    // all, so it has no issuer identity to publish.
    describeIssuer(): Promise<IssuerDescription> {
      throw new NotImplementedError(CAPABILITY, 'describeIssuer');
    },
  };
}
