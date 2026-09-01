// Invariant 2 (MISSION.md): a third party can verify what this service
// stores, or in this case what it accepted over the wire, without calling
// it. R-34 touches identity and the hire loop, so the strongest honest
// evidence this file can offer is: (1) a signature is an authentication
// event, not a fact this service records or serves back, (2) a third party
// holding only a signed request's own headers and RFC 9421's public spec can
// re-derive the same verdict this service reached, with no import from src/
// and no call to this service, and (3) the property that makes (2) possible
// -- a did:abt DID is a cryptographic commitment to its key -- is the DID
// method's, not something this service invented.
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020';
import { fromPublicKey } from '@arcblock/did';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';
import type { Delegation } from '../../src/domain/agent.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { mintSessionToken, testSessionAdapter } from '../helpers/session-fixtures.js';

const AGENT_DID = 'did:abt:agent-sig-invariant2';

function delegationFixture(): Delegation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-sig-invariant2',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: 'did:abt:op-sig-invariant2',
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: AGENT_DID },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${AGENT_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

// A word that would mean a request signature, a key or key material leaked
// into a stored or served fact. Matched case-insensitively by substring:
// a request signature is an authentication event over one HTTP call, never a
// property of the job it authenticated.
const LEAK_WORDS = ['signature', 'keyid', 'publickey', 'pem'];
function findLeaks(value: unknown): string {
  const text = JSON.stringify(value).toLowerCase();
  return LEAK_WORDS.filter((word) => text.includes(word)).join(', ');
}

// An independent verifier: given ONLY a signed request's own headers and the
// method/target-uri it named, reconstruct the ed25519 public key from the
// keyid's fingerprint (RFC 9421 + the did:abt method's own fromFingerprint
// convention), require it to re-derive the claimed DID (the did:abt binding
// check, the DID method's own property), rebuild the signature base from the
// wire bytes alone, and verify with node:crypto. No import from src/, no
// call to this service.
async function independentlyVerify(
  headers: Record<string, string>,
  method: string,
  targetUri: string,
): Promise<{ did: string } | null> {
  try {
    const sigInputMatch = headers['signature-input']?.trim().match(/^([A-Za-z0-9_-]+)=\((.*?)\)(.*)$/);
    if (!sigInputMatch) return null;
    const label = sigInputMatch[1] ?? '';
    const inner = sigInputMatch[2] ?? '';
    const rawParams = sigInputMatch[3] ?? '';
    const components = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');

    const keyidMatch = rawParams.match(/;keyid="([^"]*)"/);
    const keyid = keyidMatch?.[1] ?? '';
    const hashIndex = keyid.indexOf('#');
    if (hashIndex === -1) return null;
    const did = keyid.slice(0, hashIndex);
    const fragment = keyid.slice(hashIndex + 1);

    // Reconstruct the key from the fingerprint alone -- what any stranger
    // holding the request can do, per the did:abt convention.
    const key = await Ed25519VerificationKey2020.fromFingerprint({ fingerprint: fragment });
    const raw = (key as unknown as { _publicKeyBuffer: Uint8Array })._publicKeyBuffer;

    // The did:abt binding check: a did:abt DID is a commitment to its
    // ed25519 public key, so a key that does not re-derive the claimed
    // suffix does not belong to that DID, no matter what the fragment says.
    if (fromPublicKey(raw) !== did.replace(/^did:abt:/, '')) return null;

    const lines: string[] = [];
    for (const component of components) {
      if (component === '@method') {
        lines.push(`"@method": ${method.toUpperCase()}`);
      } else if (component === '@target-uri') {
        lines.push(`"@target-uri": ${targetUri}`);
      } else {
        const value = headers[component];
        if (value === undefined) return null;
        lines.push(`"${component}": ${value}`);
      }
    }
    lines.push(`"@signature-params": (${inner})${rawParams}`);
    const base = lines.join('\n');

    const sigMatch = headers.signature?.match(new RegExp(`(?:^|,)\\s*${label}=:([A-Za-z0-9+/=]+):`));
    if (!sigMatch) return null;
    const sigBytes = Buffer.from(sigMatch[1] ?? '', 'base64');

    const publicKeyPem = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    }).export({ type: 'spki', format: 'pem' }) as string;

    if (!nodeVerify(null, Buffer.from(base, 'utf8'), createPublicKey(publicKeyPem), sigBytes)) return null;
    return { did };
  } catch {
    return null;
  }
}

describe('DID-signed requests, invariant 2 (R-34): third-party verifiability', () => {
  it('a signed request leaves no signature, key or key-material trace in what the service serves', async () => {
    const repo = new MemoryOperatorRepository();
    const agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: AGENT_DID,
      operatorDid: 'did:abt:op-sig-invariant2',
      delegation: delegationFixture(),
      name: 'scout',
      skills: ['triage'],
      githubLogin: null,
    });
    const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(41));
    await repo.register({ did: buyer.did, githubLogin: 'buyer-sig-invariant2' });
    const sessionAdapter = testSessionAdapter();

    let server: Server | undefined;
    try {
      server = createApp(
        repo,
        agentRepo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sessionAdapter,
      ).listen(0);
      await new Promise<void>((resolve) => server?.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected server to listen on a port');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const unsignedBody = JSON.stringify({
        buyerDid: 'did:abt:session-buyer',
        agentDid: AGENT_DID,
        repository: 'buyer/target-repo',
        brief: 'Unsigned draft',
      });
      // "Unsigned" here means authenticated via a session rather than an
      // R-34 signature: proving the OTHER accepted identity path (R-39)
      // leaves the same no-leak guarantee, now that POST /jobs refuses a
      // caller with neither.
      const token = await mintSessionToken(sessionAdapter);
      const unsigned = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: unsignedBody,
      });
      expect(unsigned.status).toBe(201);
      const unsignedJob = (await unsigned.json()) as Record<string, unknown>;

      const signedBody = JSON.stringify({
        buyerDid: buyer.did,
        agentDid: AGENT_DID,
        repository: 'buyer/target-repo',
        brief: 'Signed draft',
      });
      const targetUri = `${baseUrl}/jobs`;
      const signed = signRequest(buyer, 'POST', targetUri, { body: signedBody });
      const signedResponse = await fetch(targetUri, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'signature-input': signed['signature-input'],
          signature: signed.signature,
          'content-digest': signed['content-digest'],
        },
        body: signedBody,
      });
      expect(signedResponse.status).toBe(201);
      const signedJob = (await signedResponse.json()) as Record<string, unknown>;

      // The projection contract is unaffected by how the request arrived:
      // the same key set either way.
      expect(Object.keys(signedJob).sort()).toEqual(Object.keys(unsignedJob).sort());

      expect(findLeaks(unsignedJob)).toBe('');
      expect(findLeaks(signedJob)).toBe('');
    } finally {
      server?.close();
    }
  });

  it('a third party re-verifies a signed request from its own headers alone, with no key from this service', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(51));
    const targetUri = 'http://127.0.0.1:1/jobs';
    const body = '{"hello":"world"}';
    const signed = signRequest(identity, 'POST', targetUri, { body });

    const result = await independentlyVerify(signed, 'POST', targetUri);

    expect(result).toEqual({ did: identity.did });
  });

  it('a did:abt DID is a commitment to its key: a forged keyid fails the independent verifier for the same reason it fails this service', async () => {
    const victim = await signingIdentityFromSeed(new Uint8Array(32).fill(61));
    const attacker = await signingIdentityFromSeed(new Uint8Array(32).fill(71));
    const attackerFragment = attacker.keyid.slice(attacker.keyid.indexOf('#') + 1);

    // The attacker's own key material, presented under the victim's DID.
    const forged: SigningIdentity = {
      did: victim.did,
      keyid: `${victim.did}#${attackerFragment}`,
      privateKey: attacker.privateKey,
    };
    const targetUri = 'http://127.0.0.1:1/jobs';
    const body = '{"hello":"world"}';
    const signed = signRequest(forged, 'POST', targetUri, { body });

    const result = await independentlyVerify(signed, 'POST', targetUri);

    expect(result).toBeNull();
  });
});
