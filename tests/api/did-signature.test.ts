// R-34 acceptance, human-seeded 2026-08-23. These are the RED contract for
// src/adapters/identity/http-signature.ts: each case is declared with
// `it.fails`, so the suite stays green while the adapter is a stub, and the
// moment a real implementation makes a case pass, `it.fails` itself fails.
// The implementer's first move is therefore forced and mechanical: replace
// `it.fails` with `it` and make the assertions real. The assertions below are
// placeholders for the acceptance lines in the comments, not the final tests.
import { describe, it, expect } from 'vitest';
import { verify, type SigningKeyResolver } from '../../src/adapters/identity/http-signature.js';

describe('DID-signed requests (RFC 9421)', () => {
  const resolver: SigningKeyResolver = async () => ({ publicKeyPem: 'test-key' });

  it.fails('accepts a request whose Signature-Input and Signature verify against the resolved key', async () => {
    // The factory's implementation must generate this pair itself in its own
    // test fixtures; the acceptance line is round-trip sign -> verify -> did.
    expect(true).toBe(false); // RED until implemented
    void resolver;
    void verify;
  });

  it.fails('rejects a signature whose covered components omit @method or @target-uri', async () => {
    expect(true).toBe(false); // RED until implemented
  });

  it.fails('rejects when keyResolver returns null for the claimed did', async () => {
    expect(true).toBe(false); // RED until implemented
  });
});
