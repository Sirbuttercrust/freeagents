// platformIssuerFromEnv (ISS1, bugs.md B30): the issuer DID is now ALWAYS
// derived from the signing key (FREEAGENTS_PLATFORM_SEED), through the
// exact same derivation createOperatorDid uses (did-from-seed.ts's
// deriveDidFromSeed) so an issuer DID and an operator DID can never encode
// a key two different ways. FREEAGENTS_PLATFORM_DID no longer has any
// effect on the issued DID: it is gone as a configuration knob, and if a
// deployment still sets it, one warning names the fact that it is ignored
// and states the DID that is actually in effect.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformIssuerFromEnv, publicBaseUrlFromEnv } from '../../../src/adapters/credentials/credentials.js';
import { deriveDidFromSeed } from '../../../src/adapters/identity/did-from-seed.js';

const ORIGINAL_DID = process.env.FREEAGENTS_PLATFORM_DID;
const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;
const ORIGINAL_BASE = process.env.FREEAGENTS_PUBLIC_BASE_URL;

function restoreVar(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

describe('platformIssuerFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreVar('FREEAGENTS_PLATFORM_DID', ORIGINAL_DID);
    restoreVar('FREEAGENTS_PLATFORM_SEED', ORIGINAL_SEED);
    vi.restoreAllMocks();
  });

  it('a configured 64-hex seed derives the issuer DID from its own public key, with no warning', async () => {
    const hex = 'a1'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', hex);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    const expected = await deriveDidFromSeed(Uint8Array.from(Buffer.from(hex, 'hex')));
    expect(issuer.did).toBe(expected.did);
    expect(issuer.did.startsWith('did:abt:')).toBe(true);
    expect(issuer.seed).toHaveLength(32);
    expect(Buffer.from(issuer.seed).toString('hex')).toBe(hex);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a 0x-prefixed seed decodes to the same 32 bytes and the same derived DID', async () => {
    const hex = 'b2'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', `0x${hex}`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    const expected = await deriveDidFromSeed(Uint8Array.from(Buffer.from(hex, 'hex')));
    expect(issuer.seed).toHaveLength(32);
    expect(Buffer.from(issuer.seed).toString('hex')).toBe(hex);
    expect(issuer.did).toBe(expected.did);
  });

  it('an uppercase hex seed, with no prefix, decodes to the same 32 bytes and the same derived DID', async () => {
    const hex = 'b2'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', hex.toUpperCase());
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    const expected = await deriveDidFromSeed(Uint8Array.from(Buffer.from(hex, 'hex')));
    expect(issuer.seed).toHaveLength(32);
    expect(Buffer.from(issuer.seed).toString('hex')).toBe(hex);
    expect(issuer.did).toBe(expected.did);
  });

  it('a 0X-prefixed (uppercase prefix) seed decodes to the same 32 bytes, not an empty seed', async () => {
    const hex = 'b2'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', `0X${hex}`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    expect(issuer.seed).toHaveLength(32);
    expect(Buffer.from(issuer.seed).toString('hex')).toBe(hex);
  });

  it('no seed configured falls back to a 32-byte ephemeral seed, a DID derived from that seed, and one warning naming the variable', async () => {
    vi.unstubAllEnvs();
    delete process.env.FREEAGENTS_PLATFORM_DID;
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    expect(issuer.did.startsWith('did:abt:')).toBe(true);
    const expected = await deriveDidFromSeed(issuer.seed);
    expect(issuer.did).toBe(expected.did);
    expect(issuer.seed).toHaveLength(32);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('FREEAGENTS_PLATFORM_SEED');
  });

  it('two calls without a seed produce different ephemeral seeds and different derived DIDs', async () => {
    vi.unstubAllEnvs();
    delete process.env.FREEAGENTS_PLATFORM_DID;
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await platformIssuerFromEnv();
    const second = await platformIssuerFromEnv();

    expect(Buffer.from(first.seed).toString('hex')).not.toBe(Buffer.from(second.seed).toString('hex'));
    expect(first.did).not.toBe(second.did);
  });

  it('a malformed seed (not hex) takes the ephemeral path and warns', async () => {
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', 'not-hex');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    expect(issuer.seed).toHaveLength(32);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a malformed seed (63 hex characters) takes the ephemeral path and warns', async () => {
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', 'c3'.repeat(31) + 'c');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    expect(issuer.seed).toHaveLength(32);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('invariant 10 in test form: the ephemeral-path warning never contains the malformed value or a secret-material stem', async () => {
    const malformed = 'not-a-real-seed-value';
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', malformed);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await platformIssuerFromEnv();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]).toLowerCase();
    expect(message).not.toContain(malformed);
    for (const stem of ['privatekey', 'secretkey', 'mnemonic']) {
      expect(message).not.toContain(stem);
    }
  });

  it('FREEAGENTS_PLATFORM_DID has no effect on the issued DID, even when set to a plausible-looking value', async () => {
    const hex = 'c4'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', hex);
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', 'did:abt:zSomeConfiguredValue');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    expect(issuer.did).not.toBe('did:abt:zSomeConfiguredValue');
    const expected = await deriveDidFromSeed(Uint8Array.from(Buffer.from(hex, 'hex')));
    expect(issuer.did).toBe(expected.did);
  });

  it('warns once, naming FREEAGENTS_PLATFORM_DID and the derived DID, when the variable is still set', async () => {
    const hex = 'd5'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', hex);
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', 'did:abt:zIgnoredValue');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = await platformIssuerFromEnv();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('FREEAGENTS_PLATFORM_DID');
    expect(message).toContain(issuer.did);
  });

  it('an EMPTY string FREEAGENTS_PLATFORM_DID does not trigger the ignored-variable warning (Blocklet Server materialises unset vars as \'\')', async () => {
    const hex = 'e6'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', hex);
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await platformIssuerFromEnv();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('publicBaseUrlFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreVar('FREEAGENTS_PUBLIC_BASE_URL', ORIGINAL_BASE);
  });

  it('a configured base is used verbatim', () => {
    vi.stubEnv('FREEAGENTS_PUBLIC_BASE_URL', 'https://credentials.example');

    expect(publicBaseUrlFromEnv()).toBe('https://credentials.example');
  });

  it('an EMPTY string falls back to the default, never an empty origin', () => {
    // Same defect PR #71 found on the DID: Blocklet Server materialises
    // declared env vars, so an unconfigured deployment delivers '' rather
    // than undefined, and `??` would miss it.
    vi.stubEnv('FREEAGENTS_PUBLIC_BASE_URL', '');

    expect(publicBaseUrlFromEnv()).toBe('http://localhost:3000');
  });

  it('unset falls back to the default', () => {
    vi.unstubAllEnvs();
    delete process.env.FREEAGENTS_PUBLIC_BASE_URL;

    expect(publicBaseUrlFromEnv()).toBe('http://localhost:3000');
  });

  it('a trailing slash is stripped, so an id carries one separator', () => {
    vi.stubEnv('FREEAGENTS_PUBLIC_BASE_URL', 'https://credentials.example/');

    expect(publicBaseUrlFromEnv()).toBe('https://credentials.example');
  });

  it('a base of nothing but slashes falls back to the default', () => {
    vi.stubEnv('FREEAGENTS_PUBLIC_BASE_URL', '///');

    expect(publicBaseUrlFromEnv()).toBe('http://localhost:3000');
  });
});
