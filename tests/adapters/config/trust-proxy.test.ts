// S11: FREEAGENTS_TRUST_PROXY parsing. Express's own `trust proxy` setting
// accepts a boolean, a hop count (number), or a string/array of IPs,
// subnets, or the pre-defined names 'loopback' / 'linklocal' / 'uniquelocal'
// (https://expressjs.com/en/guide/behind-proxies.html). This module reads
// the env var's raw string form and produces the typed value `app.set`
// expects: 'true'/'false' become real booleans (a bare string 'true' would
// otherwise be handed to proxy-addr as an IP literal and rejected), a
// digit-only string becomes a real number (the hop-count form), and
// anything else passes through as the string Express's own compileTrust
// already knows how to parse (a CSV list of subnets/addresses).
import { describe, expect, it } from 'vitest';
import { parseTrustProxyEnv, trustProxySettingFromEnv } from '../../../src/adapters/config/trust-proxy.js';

describe('parseTrustProxyEnv', () => {
  it('parses the literal string "true" as the boolean true', () => {
    expect(parseTrustProxyEnv('true')).toBe(true);
  });

  it('parses the literal string "false" as the boolean false', () => {
    expect(parseTrustProxyEnv('false')).toBe(false);
  });

  it('parses a digit-only string as a real number (the hop-count form)', () => {
    expect(parseTrustProxyEnv('1')).toBe(1);
    expect(parseTrustProxyEnv('2')).toBe(2);
  });

  it('passes through a subnet name unchanged, for Express\'s own compileTrust to parse', () => {
    expect(parseTrustProxyEnv('loopback')).toBe('loopback');
  });

  it('passes through a CSV address list unchanged', () => {
    expect(parseTrustProxyEnv('192.0.2.1,192.0.2.2')).toBe('192.0.2.1,192.0.2.2');
  });
});

describe('trustProxySettingFromEnv', () => {
  it('defaults to false (a directly exposed server) when the variable is unset', () => {
    expect(trustProxySettingFromEnv({})).toBe(false);
  });

  it('defaults to false when the variable is set to an empty string', () => {
    expect(trustProxySettingFromEnv({ FREEAGENTS_TRUST_PROXY: '' })).toBe(false);
  });

  it('reads a hop count from the environment', () => {
    expect(trustProxySettingFromEnv({ FREEAGENTS_TRUST_PROXY: '1' })).toBe(1);
  });

  it('reads the boolean true from the environment', () => {
    expect(trustProxySettingFromEnv({ FREEAGENTS_TRUST_PROXY: 'true' })).toBe(true);
  });
});
