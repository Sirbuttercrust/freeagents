// P9: the configuration report an operator reads at startup. Additive
// alongside each rail's own call-time fail-closed guard (abt.ts, usdc.ts):
// this module never throws and never replaces a guard, it only answers
// "what is configured on this deployment" from the same environment those
// guards already read.
import { describe, expect, it } from 'vitest';
import { buildConfigReport, formatConfigReport } from '../../../src/adapters/config/report.js';

describe('buildConfigReport: database capability', () => {
  it('reports database as configured when DATABASE_URL is set', () => {
    const report = buildConfigReport({ DATABASE_URL: 'postgresql://example' });
    const database = report.capabilities.find((c) => c.capability === 'database');
    expect(database?.configured).toBe(true);
    expect(database?.missing).toEqual([]);
  });

  it('reports database as not configured, naming DATABASE_URL, when unset', () => {
    const report = buildConfigReport({});
    const database = report.capabilities.find((c) => c.capability === 'database');
    expect(database?.configured).toBe(false);
    expect(database?.missing).toEqual(['DATABASE_URL']);
  });

  it('treats an explicit empty string the same as unset (Blocklet Server materialises unset vars as \'\')', () => {
    const report = buildConfigReport({ DATABASE_URL: '' });
    const database = report.capabilities.find((c) => c.capability === 'database');
    expect(database?.configured).toBe(false);
    expect(database?.missing).toEqual(['DATABASE_URL']);
  });
});

const ABT_ENV = {
  FREEAGENTS_ABT_CHAIN_HOST: 'https://beta.abtnetwork.io/api',
  FREEAGENTS_ABT_PLATFORM_SK: '0'.repeat(64),
  FREEAGENTS_ABT_TOKEN: 'z1Token',
  FREEAGENTS_ABT_FEE_ADDRESS: 'z1Fee',
};

const USDC_ENV = {
  FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
  FREEAGENTS_USDC_TOKEN_CONTRACT: '0x1111111111111111111111111111111111111111',
  FREEAGENTS_USDC_CHAIN_ID: '421614',
  FREEAGENTS_USDC_FEE_ADDRESS: '0x2222222222222222222222222222222222222222',
};

describe('buildConfigReport: abt rail', () => {
  it('is configured only when all four abt env vars are set', () => {
    const report = buildConfigReport(ABT_ENV);
    const abt = report.capabilities.find((c) => c.capability === 'abtRail');
    expect(abt?.configured).toBe(true);
    expect(abt?.missing).toEqual([]);
  });

  it('names exactly the missing abt vars, one at a time', () => {
    const rest = { ...ABT_ENV, FREEAGENTS_ABT_TOKEN: undefined };
    const report = buildConfigReport(rest);
    const abt = report.capabilities.find((c) => c.capability === 'abtRail');
    expect(abt?.configured).toBe(false);
    expect(abt?.missing).toEqual(['FREEAGENTS_ABT_TOKEN']);
  });

  it('treats an empty-string abt var as missing, not set', () => {
    const report = buildConfigReport({ ...ABT_ENV, FREEAGENTS_ABT_TOKEN: '' });
    const abt = report.capabilities.find((c) => c.capability === 'abtRail');
    expect(abt?.configured).toBe(false);
    expect(abt?.missing).toEqual(['FREEAGENTS_ABT_TOKEN']);
  });

  // Same defect class as D1/D2 (review round 1), on the abt rail's
  // own sibling variable: createAbtPaymentRail (abt.ts) constructs a wallet
  // from FREEAGENTS_ABT_PLATFORM_SK via @ocap/wallet's fromSecretKey, which
  // throws on a malformed key. The report must not call that value
  // "configured" either.
  it('abtRail is not configured with a malformed platform secret key', () => {
    const report = buildConfigReport({ ...ABT_ENV, FREEAGENTS_ABT_PLATFORM_SK: 'not-a-valid-secret-key' });
    const abt = report.capabilities.find((c) => c.capability === 'abtRail');
    expect(abt?.configured).toBe(false);
    expect(abt?.missing).toEqual(['FREEAGENTS_ABT_PLATFORM_SK']);
  });
});

describe('buildConfigReport: usdc rail', () => {
  it('is configured only when all four usdc env vars are set', () => {
    const report = buildConfigReport(USDC_ENV);
    const usdc = report.capabilities.find((c) => c.capability === 'usdcRail');
    expect(usdc?.configured).toBe(true);
    expect(usdc?.missing).toEqual([]);
  });

  it('names exactly the missing usdc vars', () => {
    const rest = { ...USDC_ENV, FREEAGENTS_USDC_CHAIN_ID: undefined, FREEAGENTS_USDC_FEE_ADDRESS: undefined };
    const report = buildConfigReport(rest);
    const usdc = report.capabilities.find((c) => c.capability === 'usdcRail');
    expect(usdc?.configured).toBe(false);
    expect(usdc?.missing).toEqual(['FREEAGENTS_USDC_CHAIN_ID', 'FREEAGENTS_USDC_FEE_ADDRESS']);
  });

  it('treats an empty-string usdc var as missing, not set', () => {
    const report = buildConfigReport({ ...USDC_ENV, FREEAGENTS_USDC_RPC_URL: '' });
    const usdc = report.capabilities.find((c) => c.capability === 'usdcRail');
    expect(usdc?.configured).toBe(false);
    expect(usdc?.missing).toEqual(['FREEAGENTS_USDC_RPC_URL']);
  });

  // D2 (review round 1): readUsdcEnvConfig (usdc.ts) throws
  // PaymentConfigError on a chain id that does not parse as a positive
  // integer. The report must not call that same value "configured": the
  // reviewer's reproduction showed the startup log saying usdcRail was
  // ready on a deployment where createUsdcPaymentRail cannot construct.
  it('usdcRail is not configured with a non-numeric chain id', () => {
    const report = buildConfigReport({ ...USDC_ENV, FREEAGENTS_USDC_CHAIN_ID: 'not-a-number' });
    const usdc = report.capabilities.find((c) => c.capability === 'usdcRail');
    expect(usdc?.configured).toBe(false);
    expect(usdc?.missing).toEqual(['FREEAGENTS_USDC_CHAIN_ID']);
  });
});

describe('buildConfigReport: credentials, github sign-in, github api', () => {
  it('credentials is not configured without a platform seed (ephemeral dev key otherwise)', () => {
    const report = buildConfigReport({});
    const credentials = report.capabilities.find((c) => c.capability === 'credentials');
    expect(credentials?.configured).toBe(false);
    expect(credentials?.missing).toEqual(['FREEAGENTS_PLATFORM_SEED']);
  });

  it('credentials is configured once the platform seed is set', () => {
    const report = buildConfigReport({ FREEAGENTS_PLATFORM_SEED: '0'.repeat(64) });
    const credentials = report.capabilities.find((c) => c.capability === 'credentials');
    expect(credentials?.configured).toBe(true);
  });

  // D1 (review round 1): platformIssuerFromEnv (credentials.ts) only
  // accepts a 64-hex-character seed and falls back to an ephemeral dev key
  // for anything else, including a non-empty malformed value. The report
  // must not call a malformed seed "configured": that is the exact
  // silent-success-on-failure the reviewer reproduced.
  it('credentials is not configured with a non-empty but malformed platform seed', () => {
    const report = buildConfigReport({ FREEAGENTS_PLATFORM_SEED: 'not-a-hex-seed' });
    const credentials = report.capabilities.find((c) => c.capability === 'credentials');
    expect(credentials?.configured).toBe(false);
    expect(credentials?.missing).toEqual(['FREEAGENTS_PLATFORM_SEED']);
  });

  it('githubSignIn needs both the oauth client id and secret', () => {
    const report = buildConfigReport({ FREEAGENTS_GITHUB_CLIENT_ID: 'abc' });
    const githubSignIn = report.capabilities.find((c) => c.capability === 'githubSignIn');
    expect(githubSignIn?.configured).toBe(false);
    expect(githubSignIn?.missing).toEqual(['FREEAGENTS_GITHUB_CLIENT_SECRET']);
  });

  it('githubApi needs the platform token', () => {
    const report = buildConfigReport({});
    const githubApi = report.capabilities.find((c) => c.capability === 'githubApi');
    expect(githubApi?.configured).toBe(false);
    expect(githubApi?.missing).toEqual(['FREEAGENTS_GITHUB_TOKEN']);
  });
});

describe('buildConfigReport: enabledRails (D3, review round 1)', () => {
  // FREEAGENTS_ENABLED_RAILS was declared and documented but nothing ever
  // read it (inert-declared-control). Unset or empty keeps existing
  // behaviour (both rails offered), which this report treats as trivially
  // configured: there is nothing for the operator to have gotten wrong.
  it('is configured when unset (both rails offered, existing behaviour)', () => {
    const report = buildConfigReport({});
    const enabledRails = report.capabilities.find((c) => c.capability === 'enabledRails');
    expect(enabledRails?.configured).toBe(true);
    expect(enabledRails?.missing).toEqual([]);
  });

  it('is configured when empty', () => {
    const report = buildConfigReport({ FREEAGENTS_ENABLED_RAILS: '' });
    const enabledRails = report.capabilities.find((c) => c.capability === 'enabledRails');
    expect(enabledRails?.configured).toBe(true);
  });

  it('is configured when it names a rail that is itself fully configured', () => {
    const report = buildConfigReport({ ...ABT_ENV, FREEAGENTS_ENABLED_RAILS: 'abt' });
    const enabledRails = report.capabilities.find((c) => c.capability === 'enabledRails');
    expect(enabledRails?.configured).toBe(true);
    expect(enabledRails?.missing).toEqual([]);
  });

  // The gap the reviewer named directly: setting FREEAGENTS_ENABLED_RAILS
  // to a rail promises (per its own manifest description) that this
  // deployment offers that rail, but nothing enforced the promise. Naming
  // an unconfigured rail here must surface as a problem, not pass silently.
  it('is not configured when it names a rail that is not fully configured, naming that rail\'s missing vars', () => {
    const report = buildConfigReport({ FREEAGENTS_ENABLED_RAILS: 'abt' });
    const enabledRails = report.capabilities.find((c) => c.capability === 'enabledRails');
    expect(enabledRails?.configured).toBe(false);
    expect(enabledRails?.missing).toEqual([
      'FREEAGENTS_ABT_CHAIN_HOST',
      'FREEAGENTS_ABT_PLATFORM_SK',
      'FREEAGENTS_ABT_TOKEN',
      'FREEAGENTS_ABT_FEE_ADDRESS',
    ]);
  });

  it('is not configured when it names an unrecognised rail, naming FREEAGENTS_ENABLED_RAILS itself', () => {
    const report = buildConfigReport({ FREEAGENTS_ENABLED_RAILS: 'not-a-real-rail' });
    const enabledRails = report.capabilities.find((c) => c.capability === 'enabledRails');
    expect(enabledRails?.configured).toBe(false);
    expect(enabledRails?.missing).toEqual(['FREEAGENTS_ENABLED_RAILS']);
  });

  it('accepts both rails named together, comma separated with spaces', () => {
    const report = buildConfigReport({ ...ABT_ENV, ...USDC_ENV, FREEAGENTS_ENABLED_RAILS: 'abt, usdc' });
    const enabledRails = report.capabilities.find((c) => c.capability === 'enabledRails');
    expect(enabledRails?.configured).toBe(true);
    expect(enabledRails?.missing).toEqual([]);
  });
});

describe('formatConfigReport: never prints a value', () => {
  it('never includes a planted secret value anywhere in the formatted output', () => {
    const plantedSecret = 'zzTOPSECRETPLATFORMSEEDVALUE99887766';
    const report = buildConfigReport({
      ...ABT_ENV,
      ...USDC_ENV,
      DATABASE_URL: `postgresql://user:${plantedSecret}@localhost:5432/db`,
      FREEAGENTS_PLATFORM_SEED: plantedSecret,
      FREEAGENTS_GITHUB_TOKEN: plantedSecret,
      FREEAGENTS_ABT_PLATFORM_SK: plantedSecret,
    });
    const output = formatConfigReport(report);
    expect(output).not.toContain(plantedSecret);
  });

  it('names each capability and states configured or missing, never a value', () => {
    const report = buildConfigReport({ DATABASE_URL: 'postgresql://example' });
    const output = formatConfigReport(report);
    expect(output).toContain('database: configured');
    expect(output).toContain('usdcRail: not configured (missing FREEAGENTS_USDC_RPC_URL');
  });
});
