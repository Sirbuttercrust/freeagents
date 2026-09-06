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
// Review round 1, D1+D2: this report DOES share the shape-validity
// predicates each rail's own reader enforces (isValidPlatformSeedHex,
// isValidAbtPlatformSk, isValidUsdcChainId), imported from the same modules
// the rails live in. "Configured" must mean the same thing here as it does
// in the code that actually constructs the rail: a value the rail would
// reject is reported as missing, naming the same variable, never silently
// waved through as present-but-wrong.
//
// Never prints or returns a value, only names and the words 'set' / 'missing'
// (see missingEnvVarNames below and formatConfigReport's own doc comment).
// This is invariant 10's fence extended into a log line: a secret that never
// reaches the tree cannot leak if this report is the only place it would
// have been printed.
import { isValidPlatformSeedHex } from '../credentials/credentials.js';
import { isValidAbtPlatformSk } from '../payment/abt.js';
import { isValidUsdcChainId } from '../payment/usdc.js';

export type Capability =
  | 'database'
  | 'credentials'
  | 'githubSignIn'
  | 'githubApi'
  | 'abtRail'
  | 'usdcRail'
  | 'enabledRails';

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

// The one place "missing" is defined for this report: absent, empty, OR
// (when a shape validator is given for that name) a non-empty value the
// consuming code would itself reject. Matches readAbtEnvConfig /
// readUsdcEnvConfig / every other env-derived factory in this codebase
// (Blocklet Server materialises every declared var, so an unconfigured
// deployment delivers '' rather than undefined).
function requireAll(
  env: Record<string, string | undefined>,
  names: readonly string[],
  validators: Readonly<Partial<Record<string, (value: string) => boolean>>> = {},
): CapabilityReport['missing'] {
  return names.filter((name) => {
    const value = readEnv(env, name);
    if (value === '') return true;
    const isValid = validators[name];
    return isValid !== undefined && !isValid(value);
  });
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

// Only FREEAGENTS_ABT_PLATFORM_SK has a shape narrower than "non-empty
// string" (createAbtPaymentRail constructs a wallet from it via
// @ocap/wallet's fromSecretKey, which throws on a malformed key; review
// round 1, D1's sibling case on the abt rail). The other three are
// opaque strings (a host, a token contract, a fee address) this report has
// no independent way to validate beyond "did the operator set something".
const ABT_RAIL_VALIDATORS = { FREEAGENTS_ABT_PLATFORM_SK: isValidAbtPlatformSk };

const USDC_RAIL_VARS = [
  'FREEAGENTS_USDC_RPC_URL',
  'FREEAGENTS_USDC_TOKEN_CONTRACT',
  'FREEAGENTS_USDC_CHAIN_ID',
  'FREEAGENTS_USDC_FEE_ADDRESS',
] as const;

// Only FREEAGENTS_USDC_CHAIN_ID has a shape narrower than "non-empty
// string" (readUsdcEnvConfig throws PaymentConfigError on a non-integer;
// review round 1, D2).
const USDC_RAIL_VALIDATORS = { FREEAGENTS_USDC_CHAIN_ID: isValidUsdcChainId };

// The rail names FREEAGENTS_ENABLED_RAILS may list, each mapped to the same
// vars/validators its own capability report already checks. Single source
// of truth: enabledRails below re-derives from this map rather than
// duplicating either rail's variable list a third time.
const RAIL_DEFINITIONS: Readonly<
  Record<'abt' | 'usdc', { readonly vars: readonly string[]; readonly validators: Record<string, (v: string) => boolean> }>
> = {
  abt: { vars: ABT_RAIL_VARS, validators: ABT_RAIL_VALIDATORS },
  usdc: { vars: USDC_RAIL_VARS, validators: USDC_RAIL_VALIDATORS },
};

// D3 (review round 1): FREEAGENTS_ENABLED_RAILS was declared in
// blocklet.yml and .env.example but nothing read it, so its own manifest
// description promised an effect the code never implemented
// (inert-declared-control). This report is the chosen fix: naming a rail
// here that is not itself fully configured is surfaced as a problem, and
// naming a string that is not a known rail is surfaced against the
// variable itself, so a typo ("abtt") is never silently ignored. Unset or
// empty is always configured, matching the description's "means both,
// which is the existing behaviour".
function enabledRailsReport(env: Record<string, string | undefined>): CapabilityReport {
  const raw = readEnv(env, 'FREEAGENTS_ENABLED_RAILS');
  if (raw === '') return capabilityReport('enabledRails', []);

  const named = raw.split(',').map((entry) => entry.trim());
  const missing = named.flatMap((rail) => {
    const definition = RAIL_DEFINITIONS[rail as 'abt' | 'usdc'];
    if (definition === undefined) return ['FREEAGENTS_ENABLED_RAILS'];
    return requireAll(env, definition.vars, definition.validators);
  });
  // A rail named twice, or two unrecognised entries, must not repeat the
  // same missing name twice in the operator-facing report.
  return capabilityReport('enabledRails', [...new Set(missing)]);
}

// Credentials (platformIssuerFromEnv, credentials.ts) has a real fallback:
// an unset seed still issues, on an ephemeral dev key. So "configured" here
// means the seed is set to a value that will actually verify past a
// restart, not merely that construction will not throw (it never throws).
// isValidPlatformSeedHex is the same 64-hex-character check
// platformIssuerFromEnv itself applies (review round 1, D1).
const CREDENTIALS_VARS = ['FREEAGENTS_PLATFORM_SEED'] as const;
const CREDENTIALS_VALIDATORS = { FREEAGENTS_PLATFORM_SEED: isValidPlatformSeedHex };

const GITHUB_SIGN_IN_VARS = ['FREEAGENTS_GITHUB_CLIENT_ID', 'FREEAGENTS_GITHUB_CLIENT_SECRET'] as const;

// B14a: the token alone is not enough. Every mutating staging-lifecycle
// call (createStagingRepository, grantPush, openStagedPullRequest) fences
// itself to FREEAGENTS_GITHUB_PLATFORM_LOGIN and fails closed with
// NotPlatformOwnerError without it, so a deployment with only the token
// set is not actually configured for the hire loop's write path.
const GITHUB_API_VARS = ['FREEAGENTS_GITHUB_TOKEN', 'FREEAGENTS_GITHUB_PLATFORM_LOGIN'] as const;

export function buildConfigReport(env: Record<string, string | undefined> = process.env): ConfigReport {
  return {
    capabilities: [
      capabilityReport('database', requireAll(env, ['DATABASE_URL'])),
      capabilityReport('credentials', requireAll(env, CREDENTIALS_VARS, CREDENTIALS_VALIDATORS)),
      capabilityReport('githubSignIn', requireAll(env, GITHUB_SIGN_IN_VARS)),
      capabilityReport('githubApi', requireAll(env, GITHUB_API_VARS)),
      capabilityReport('abtRail', requireAll(env, ABT_RAIL_VARS, ABT_RAIL_VALIDATORS)),
      capabilityReport('usdcRail', requireAll(env, USDC_RAIL_VARS, USDC_RAIL_VALIDATORS)),
      enabledRailsReport(env),
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
