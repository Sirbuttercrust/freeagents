// S11 (security sweep 2026-09-06): the caller's real address, behind a
// proxy. `req.ip` is only trustworthy once Express is told which hop to
// believe (app.set('trust proxy', ...)); FREEAGENTS_TRUST_PROXY is the one
// env variable that decides that setting for this deployment. Default is
// `false`, the safe stance for a directly exposed server: `req.ip` reads
// the real socket address and a forged X-Forwarded-For changes nothing. A
// deployment behind exactly one reverse proxy sets it to `1` (Express's own
// hop-count form), naming the proxy as the one hop to trust and nothing
// beyond it.
//
// Values are Express's own documented forms
// (https://expressjs.com/en/guide/behind-proxies.html): the boolean
// `true`/`false`, a hop count, or a comma-separated list of addresses,
// subnets, or the pre-defined names `loopback` / `linklocal` / `uniquelocal`.
// Express hands the RAW value straight to `proxy-addr`'s own `compile()`
// (utils.js's compileTrust), which does its own type-dispatch on
// typeof val -- a string `'true'` sent through unparsed would be handed to
// proxy-addr as an IP literal and rejected, and a string `'1'` would be
// handed through as a CSV list of one bogus address rather than the
// intended hop count. This module performs the same string-to-typed-value
// coercion `app.set` needs BEFORE that dispatch, reading only the env
// variable's raw string.
export const TRUST_PROXY_ENV_VAR = 'FREEAGENTS_TRUST_PROXY';

// Express's own accepted shape for `app.set('trust proxy', ...)`.
export type TrustProxySetting = boolean | number | string;

const DIGITS_ONLY = /^\d+$/;

// Refuses anything that is not one of Express's own documented forms,
// naming FREEAGENTS_TRUST_PROXY in the message so a startup failure points
// straight at the variable responsible (Make item 1: "refuse anything else
// at startup with a message naming the variable").
export class InvalidTrustProxyError extends Error {
  constructor(raw: string) {
    super(
      `${TRUST_PROXY_ENV_VAR} is set to an unrecognised value (${JSON.stringify(raw)}). ` +
        "Use 'true', 'false', a hop count (a whole number), or a comma-separated list of " +
        "IP addresses, subnets, or the names 'loopback', 'linklocal', 'uniquelocal'.",
    );
    this.name = 'InvalidTrustProxyError';
  }
}

// Parses the env variable's raw string form into the typed value Express's
// own `app.set('trust proxy', ...)` expects. Never called for an unset or
// empty variable -- trustProxySettingFromEnv below handles that case by
// returning the default directly, so this function's caller always has a
// non-empty string to hand it.
export function parseTrustProxyEnv(raw: string): TrustProxySetting {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  if (DIGITS_ONLY.test(trimmed)) return Number(trimmed);
  // Anything else (a subnet name, an address, or a CSV list of either) is
  // Express's own string form: passed through unchanged for its compileTrust
  // to parse. An address that is not valid IP/CIDR notation is refused by
  // Express itself, at app.set() time, which is where createApp's own
  // startup-refusal wiring already sits (see src/api/app.ts).
  return trimmed;
}

// The setting createApp passes to `app.set('trust proxy', ...)`. Default
// `false`: a directly exposed server keeps today's behaviour exactly (Make
// item 1). An explicit empty string counts as unset, matching every other
// FREEAGENTS_* variable's own "empty means not configured" stance in this
// codebase (src/adapters/config/report.ts's readEnv).
export function trustProxySettingFromEnv(
  env: Record<string, string | undefined> = process.env,
): TrustProxySetting {
  const raw = env[TRUST_PROXY_ENV_VAR];
  if (raw === undefined || raw === '') return false;
  return parseTrustProxyEnv(raw);
}
