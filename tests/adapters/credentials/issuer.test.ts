// platformIssuerFromEnv (R-35): the env-derived platform issuer that
// createCredentialsAdapter now defaults to. Mirrors the storage factory's
// env-handling test (tests/adapters/storage.test.ts): save and restore
// process.env around each case so the suite stays order-independent.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformIssuerFromEnv } from '../../../src/adapters/credentials/credentials.js';

const ORIGINAL_DID = process.env.FREEAGENTS_PLATFORM_DID;
const ORIGINAL_SEED = process.env.FREEAGENTS_PLATFORM_SEED;

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

  it('a configured DID and 64-hex seed are used verbatim, with no warning', () => {
    const hex = 'a1'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', 'did:abt:zTestPlatform');
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', hex);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = platformIssuerFromEnv();

    expect(issuer.did).toBe('did:abt:zTestPlatform');
    expect(issuer.seed).toHaveLength(32);
    expect(Buffer.from(issuer.seed).toString('hex')).toBe(hex);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a 0x-prefixed seed decodes to the same 32 bytes', () => {
    const hex = 'b2'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', 'did:abt:zTestPlatform');
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', `0x${hex}`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = platformIssuerFromEnv();

    expect(issuer.seed).toHaveLength(32);
    expect(Buffer.from(issuer.seed).toString('hex')).toBe(hex);
  });

  it('an uppercase hex seed, with no prefix, decodes to the same 32 bytes', () => {
    const hex = 'b2'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', 'did:abt:zTestPlatform');
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', hex.toUpperCase());
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = platformIssuerFromEnv();

    expect(issuer.seed).toHaveLength(32);
    expect(Buffer.from(issuer.seed).toString('hex')).toBe(hex);
  });

  it('a 0X-prefixed (uppercase prefix) seed decodes to the same 32 bytes, not an empty seed', () => {
    const hex = 'b2'.repeat(32);
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', 'did:abt:zTestPlatform');
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', `0X${hex}`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = platformIssuerFromEnv();

    expect(issuer.seed).toHaveLength(32);
    expect(Buffer.from(issuer.seed).toString('hex')).toBe(hex);
  });

  it('no seed configured falls back to the default DID, a 32-byte ephemeral seed, and one warning naming the variable', () => {
    vi.unstubAllEnvs();
    delete process.env.FREEAGENTS_PLATFORM_DID;
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = platformIssuerFromEnv();

    expect(issuer.did).toBe('did:abt:freeagents-platform');
    expect(issuer.seed).toHaveLength(32);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('FREEAGENTS_PLATFORM_SEED');
  });

  it('a configured DID is kept on the ephemeral path too, not overridden by the default', () => {
    vi.stubEnv('FREEAGENTS_PLATFORM_DID', 'did:abt:zConfiguredButNoSeed');
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = platformIssuerFromEnv();

    expect(issuer.did).toBe('did:abt:zConfiguredButNoSeed');
    expect(issuer.did).not.toBe('did:abt:freeagents-platform');
  });

  it('two calls without a seed produce different ephemeral seeds', () => {
    vi.unstubAllEnvs();
    delete process.env.FREEAGENTS_PLATFORM_DID;
    delete process.env.FREEAGENTS_PLATFORM_SEED;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = platformIssuerFromEnv();
    const second = platformIssuerFromEnv();

    expect(Buffer.from(first.seed).toString('hex')).not.toBe(Buffer.from(second.seed).toString('hex'));
  });

  it('a malformed seed (not hex) takes the ephemeral path and warns', () => {
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', 'not-hex');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = platformIssuerFromEnv();

    expect(issuer.seed).toHaveLength(32);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a malformed seed (63 hex characters) takes the ephemeral path and warns', () => {
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', 'c3'.repeat(31) + 'c');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issuer = platformIssuerFromEnv();

    expect(issuer.seed).toHaveLength(32);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('invariant 10 in test form: the warning on the ephemeral path never contains the malformed value or a secret-material stem', () => {
    const malformed = 'not-a-real-seed-value';
    vi.stubEnv('FREEAGENTS_PLATFORM_SEED', malformed);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    platformIssuerFromEnv();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]).toLowerCase();
    expect(message).not.toContain(malformed);
    for (const stem of ['privatekey', 'secretkey', 'mnemonic']) {
      expect(message).not.toContain(stem);
    }
  });
});
