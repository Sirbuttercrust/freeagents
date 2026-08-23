// R-34 acceptance, human-seeded 2026-08-23. These MUST fail until
// src/adapters/identity/http-signature.ts is implemented; that is the point.
import { describe, it, expect } from 'vitest';
import { verify, type SigningKeyResolver } from '../../src/adapters/identity/http-signature';

describe('DID-signed requests (RFC 9421)', () => {
  const resolver: SigningKeyResolver = async () => ({ publicKeyPem: 'test-key' });

  it('accepts a request whose Signature-Input and Signature verify against the resolved key', async () => {
    // The factory's implementation must generate this pair itself in its own
    // test fixtures; the acceptance line is round-trip sign -> verify -> did.
    expect(true).toBe(false); // RED until implemented
    void resolver;
    void verify;
  });

  it('rejects a signature whose covered components omit @method or @target-uri', async () => {
    expect(true).toBe(false); // RED until implemented
  });

  it('rejects when keyResolver returns null for the claimed did', async () => {
    expect(true).toBe(false); // RED until implemented
  });
});
