// A real (not mocked) WebAuthn "none"-attestation registration ceremony,
// built by hand so tests exercise the actual @simplewebauthn/server
// verification path with real bytes, the same "real code, not mocks"
// standard the rest of this suite holds to (tests/api/credential-resolve.test.ts
// signs and verifies real W3C credentials rather than stubbing the suite).
//
// Test-only: nothing here ships. A minimal CBOR encoder covers exactly the
// shapes a "none"-format attestationObject needs (unsigned/negative
// integers, byte strings, text strings, fixed-size maps) rather than
// pulling in a WebAuthn client emulator as a new dependency for one test
// file. https://w3c.github.io/webauthn/#sctn-none-attestation -- the "none"
// format's attStmt is an empty map, so no signature needs producing here.
import { generateKeyPairSync, createHash, createSign, randomBytes, type KeyObject } from 'node:crypto';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

function cborUint(n: number): Buffer {
  if (n < 24) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x18, n]);
  throw new Error('cborUint: value too large for this fixture builder');
}

function cborNegInt(n: number): Buffer {
  // n is the actual negative value, e.g. -7. CBOR encodes |n| - 1.
  const magnitude = -n - 1;
  if (magnitude < 24) return Buffer.from([0x20 | magnitude]);
  if (magnitude < 256) return Buffer.from([0x38, magnitude]);
  throw new Error('cborNegInt: value too large for this fixture builder');
}

function cborBytes(b: Buffer): Buffer {
  if (b.length < 24) return Buffer.concat([Buffer.from([0x40 | b.length]), b]);
  if (b.length < 256) return Buffer.concat([Buffer.from([0x58, b.length]), b]);
  throw new Error('cborBytes: value too large for this fixture builder');
}

function cborText(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  if (b.length < 24) return Buffer.concat([Buffer.from([0x60 | b.length]), b]);
  throw new Error('cborText: value too large for this fixture builder');
}

function cborMapHeader(pairCount: number): Buffer {
  if (pairCount < 16) return Buffer.from([0xa0 | pairCount]);
  throw new Error('cborMapHeader: too many pairs for this fixture builder');
}

// A COSE_Key for an ES256 (P-256) public key: kty=EC2(2), alg=ES256(-7),
// crv=P-256(1), x, y. https://www.rfc-editor.org/rfc/rfc9053
function coseEC2PublicKey(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    cborMapHeader(5),
    cborUint(1), cborUint(2), // kty: EC2
    cborUint(3), cborNegInt(-7), // alg: ES256
    cborNegInt(-1), cborUint(1), // crv: P-256
    cborNegInt(-2), cborBytes(x),
    cborNegInt(-3), cborBytes(y),
  ]);
}

// What a test can bend about one sign-in assertion. Every field defaults to
// the honest authenticator.
export interface AssertionOptions {
  // base64url of the user handle bytes; null leaves the field out.
  readonly userHandle?: string | null;
  // false clears the user-verified flag in the authenticator data.
  readonly userVerified?: boolean;
  // An explicit counter, instead of one more than the last assertion.
  readonly counter?: number;
  // Sign with another fixture's private key (a forged signature).
  readonly signWith?: PasskeyFixture;
  // Present another credential id.
  readonly credentialId?: string;
}

export interface PasskeyFixtureInit {
  // Claim an existing credential id with a new key (a "none" attestation
  // proves nothing about the id, so anyone can).
  readonly credentialId?: string;
}

export interface PasskeyFixture {
  readonly registrationResponse: (challenge: string, rpID: string) => RegistrationResponseJSON;
  readonly assertionResponse: (challenge: string, rpID: string, options?: AssertionOptions) => AuthenticationResponseJSON;
  readonly credentialId: string;
  // Remembers the registration's user.id so later assertions carry it as
  // their user handle, as a real authenticator does.
  readonly rememberUserHandle: (userHandle: string) => void;
  readonly signRaw: (data: Uint8Array) => Uint8Array<ArrayBuffer>;
}

// Builds one software passkey: a real P-256 keypair plus a real, well-formed
// "none"-attestation authenticatorData/attestationObject, so
// verifyRegistrationResponse runs its actual parsing and validation instead
// of trusting a canned success. transports omitted (optional on the JSON
// shape); backup/BE flags left off, single-device credential.
//
// The credential id is random per fixture (a fixed id would collide in a
// store keyed by it), and the private key is kept so the fixture can sign in
// later, not only register.
export function createPasskeyFixture(init: PasskeyFixtureInit = {}): PasskeyFixture {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const credentialId = Buffer.from(
    new Uint8Array(init.credentialId === undefined ? randomBytes(16) : Buffer.from(init.credentialId, 'base64url')),
  );
  let userHandle: string | undefined;
  let lastCounter = 0;

  function sign(key: KeyObject, data: Uint8Array): Uint8Array<ArrayBuffer> {
    // ES256: ECDSA over SHA-256, DER encoded, which is what WebAuthn carries.
    const signer = createSign('sha256');
    signer.update(data);
    return new Uint8Array(signer.sign(key));
  }

  return {
    credentialId: isoBase64URL.fromBuffer(credentialId),
    rememberUserHandle(handle: string): void {
      userHandle = handle;
    },
    signRaw(data: Uint8Array): Uint8Array<ArrayBuffer> {
      return sign(privateKey, data);
    },
    assertionResponse(challenge: string, rpID: string, options: AssertionOptions = {}): AuthenticationResponseJSON {
      const rpIdHash = createHash('sha256').update(rpID).digest();
      const flags = Buffer.from([options.userVerified === false ? 0x01 : 0x05]); // UP, plus UV unless turned off
      const counterValue = options.counter ?? lastCounter + 1;
      lastCounter = counterValue;
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(counterValue, 0);
      const authData = Buffer.concat([rpIdHash, flags, counter]);
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost:3000' }),
        'utf8',
      );
      const signedData = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
      const signature =
        options.signWith === undefined ? sign(privateKey, signedData) : options.signWith.signRaw(signedData);
      const handle = options.userHandle === undefined ? userHandle : (options.userHandle ?? undefined);
      const id = options.credentialId ?? isoBase64URL.fromBuffer(credentialId);
      return {
        id,
        rawId: id,
        response: {
          authenticatorData: isoBase64URL.fromBuffer(authData),
          clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
          signature: isoBase64URL.fromBuffer(signature),
          ...(handle === undefined ? {} : { userHandle: handle }),
        },
        type: 'public-key',
        clientExtensionResults: {},
      };
    },
    registrationResponse(challenge: string, rpID: string): RegistrationResponseJSON {
      const rpIdHash = Buffer.from(createHash('sha256').update(rpID).digest());
      const flags = Buffer.from([0x45]); // UP | UV | AT
      const counter = Buffer.from([0, 0, 0, 0]);
      const aaguid = Buffer.alloc(16); // all-zero: unattested software authenticator
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(credentialId.length, 0);
      const publicKeyCbor = coseEC2PublicKey(x, y);

      const authData = Buffer.concat([rpIdHash, flags, counter, aaguid, credIdLen, credentialId, publicKeyCbor]);

      const attestationObject = Buffer.concat([
        cborMapHeader(3),
        cborText('fmt'), cborText('none'),
        cborText('attStmt'), cborMapHeader(0),
        cborText('authData'), cborBytes(authData),
      ]);

      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge, origin: 'http://localhost:3000' }),
        'utf8',
      );

      return {
        id: isoBase64URL.fromBuffer(credentialId),
        rawId: isoBase64URL.fromBuffer(credentialId),
        response: {
          attestationObject: isoBase64URL.fromBuffer(attestationObject),
          clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
          transports: ['internal'],
        },
        type: 'public-key',
        clientExtensionResults: {},
      };
    },
  };
}
