// P9: the configuration report an operator reads at startup. Answers "what
// is configured on this deployment" as plain data, so src/api/server.ts can
// log a human-readable summary once, at startup, alongside (never instead
// of) each rail's own call-time fail-closed guard (abt.ts, usdc.ts).
//
// This module reads process.env directly rather than sharing readAbtEnvConfig
// / readUsdcEnvConfig: those throw a typed PaymentConfigError the instant a
// value is missing, which is exactly the behaviour this report must not
// trigger (an operator running ABT-only must be able to see a plain "USDC:
// not configured" line, not an exception at import time). Duplicating the
// four env var names per rail costs four lines; sharing the throwing reader
// would mean catching an exception as normal control flow to build a report,
// which is worse.
//
// Never prints or returns a value, only names and the words 'set' / 'missing'
// (see missingEnvVarNames below and formatConfigReport's own doc comment).
// This is invariant 10's fence extended into a log line: a secret that never
// reaches the tree cannot leak if this report is the only place it would
// have been printed.

export type Capability = 'database' | 'credentials' | 'githubSignIn' | 'githubApi' | 'abtRail' | 'usdcRail';

export interface CapabilityReport {
  readonly capability: Capability;
  readonly configured: boolean;
  readonly missing: readonly string[];
}

export interface ConfigReport {
  readonly capabilities: readonly CapabilityReport[];
}

// `??` and not `||`: an explicit empty string is not "unset" for THIS
// function, it is the caller's job to decide whether '' counts as missing.
// requireAll below is where the empty-string-means-missing rule actually
// lives, matching every rail's own `value === ''` check (abt.ts, usdc.ts).
function readEnv(env: Record<string, string | undefined>, name: string): string {
  return env[name] ?? '';
}

// The one place "missing" is defined for this report: absent OR empty,
// matching readAbtEnvConfig / readUsdcEnvConfig / every other env-derived
// factory in this codebase (Blocklet Server materialises every declared var,
// so an unconfigured deployment delivers '' rather than undefined).
function requireAll(env: Record<string, string | undefined>, names: readonly string[]): CapabilityReport['missing'] {
  return names.filter((name) => readEnv(env, name) === '');
}

function capabilityReport(capability: Capability, missing: readonly string[]): CapabilityReport {
  return { capability, configured: missing.length === 0, missing };
}

const ABT_RAIL_VARS = [
  'FREEAGENTS_ABT_CHAIN_HOST',
  'FREEAGENTS_ABT_PLATFORM_SK',
  'FREEAGENTS_ABT_TOKEN',
  'FREEAGENTS_ABT_FEE_ADDRESS',
] as const;

const USDC_RAIL_VARS = [
  'FREEAGENTS_USDC_RPC_URL',
  'FREEAGENTS_USDC_TOKEN_CONTRACT',
  'FREEAGENTS_USDC_CHAIN_ID',
  'FREEAGENTS_USDC_FEE_ADDRESS',
] as const;

// Credentials (platformIssuerFromEnv, credentials.ts) has a real fallback:
// an unset seed still issues, on an ephemeral dev key. So "configured" here
// means the seed is set to a value that will actually verify past a
// restart, not merely that construction will not throw (it never throws).
const CREDENTIALS_VARS = ['FREEAGENTS_PLATFORM_SEED'] as const;

const GITHUB_SIGN_IN_VARS = ['FREEAGENTS_GITHUB_CLIENT_ID', 'FREEAGENTS_GITHUB_CLIENT_SECRET'] as const;

const GITHUB_API_VARS = ['FREEAGENTS_GITHUB_TOKEN'] as const;

export function buildConfigReport(env: Record<string, string | undefined> = process.env): ConfigReport {
  return {
    capabilities: [
      capabilityReport('database', requireAll(env, ['DATABASE_URL'])),
      capabilityReport('credentials', requireAll(env, CREDENTIALS_VARS)),
      capabilityReport('githubSignIn', requireAll(env, GITHUB_SIGN_IN_VARS)),
      capabilityReport('githubApi', requireAll(env, GITHUB_API_VARS)),
      capabilityReport('abtRail', requireAll(env, ABT_RAIL_VARS)),
      capabilityReport('usdcRail', requireAll(env, USDC_RAIL_VARS)),
    ],
  };
}

// Human-readable summary, printed once at startup (src/api/server.ts). Names
// only, never a value: each line is "<capability>: configured" or
// "<capability>: not configured (missing FOO, BAR)". Callers must not
// concatenate this with anything containing a live env var value.
export function formatConfigReport(report: ConfigReport): string {
  const lines = report.capabilities.map((cap) => {
    if (cap.configured) return `  ${cap.capability}: configured`;
    return `  ${cap.capability}: not configured (missing ${cap.missing.join(', ')})`;
  });
  return ['configuration report:', ...lines].join('\n');
}
