// P10: lazy, non-throwing defaults for the two payment rails (brief, scope
// item 5). createAbtPaymentRail and createUsdcPaymentRail both THROW
// PaymentConfigError at construction when their env vars are absent, and
// createApp runs in a test suite where they are absent almost everywhere
// (100+ existing tests construct createApp with no payment env set at
// all). A default parameter that called either factory eagerly would
// throw at import/construction time on every one of those call sites.
// These two functions catch that error and answer null instead: an
// unconfigured rail must produce an honest 503 on the ROUTE, never a
// crash at startup.
//
// FREEAGENTS_ENABLED_RAILS (src/adapters/config/report.ts, .env.example):
// its own documented stance is that it "does NOT restrict which rail the
// platform accepts a payment on; only a rail's own four variables decide
// that" -- it exists for the startup capability report, not as a second
// gate here. These functions therefore read the SAME four-variables-per-
// rail source every other consumer of "is this rail configured" already
// reads (readAbtEnvConfig / readUsdcEnvConfig, via each factory's own
// PaymentConfigError), rather than inventing a second answer to the same
// question.
import { createAbtPaymentRail, type AbtPaymentRail } from './abt.js';
import { createUsdcPaymentRail, type UsdcPaymentRailShim } from './usdc.js';
import { PaymentConfigError } from './types.js';

export function createAbtPaymentRailOrNull(): AbtPaymentRail | null {
  try {
    return createAbtPaymentRail();
  } catch (err) {
    if (err instanceof PaymentConfigError) return null;
    throw err;
  }
}

export function createUsdcPaymentRailOrNull(): UsdcPaymentRailShim | null {
  try {
    return createUsdcPaymentRail();
  } catch (err) {
    if (err instanceof PaymentConfigError) return null;
    throw err;
  }
}
