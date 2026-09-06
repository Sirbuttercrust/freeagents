// P10: lazy, non-throwing defaults for the two payment rails (brief,
// scope item 5, "an unconfigured rail must produce an honest refusal on
// the route and never a crash at startup").
import { afterEach, describe, expect, it } from 'vitest';
import { createAbtPaymentRailOrNull, createUsdcPaymentRailOrNull } from '../../../src/adapters/payment/rail-factory.js';

const ABT_VARS = ['FREEAGENTS_ABT_CHAIN_HOST', 'FREEAGENTS_ABT_PLATFORM_SK', 'FREEAGENTS_ABT_TOKEN', 'FREEAGENTS_ABT_FEE_ADDRESS'];
const USDC_VARS = ['FREEAGENTS_USDC_RPC_URL', 'FREEAGENTS_USDC_TOKEN_CONTRACT', 'FREEAGENTS_USDC_CHAIN_ID', 'FREEAGENTS_USDC_FEE_ADDRESS'];

function withoutEnv(names: string[]): Record<string, string | undefined> {
  const original: Record<string, string | undefined> = {};
  for (const name of names) {
    original[name] = process.env[name];
    delete process.env[name];
  }
  return original;
}

function restoreEnv(original: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe('createAbtPaymentRailOrNull: never throws when the rail is unconfigured', () => {
  let original: Record<string, string | undefined>;

  afterEach(() => restoreEnv(original));

  it('answers null, not a throw, when the ABT env vars are absent', () => {
    original = withoutEnv(ABT_VARS);
    expect(() => createAbtPaymentRailOrNull()).not.toThrow();
    expect(createAbtPaymentRailOrNull()).toBeNull();
  });
});

describe('createUsdcPaymentRailOrNull: never throws when the rail is unconfigured', () => {
  let original: Record<string, string | undefined>;

  afterEach(() => restoreEnv(original));

  it('answers null, not a throw, when the USDC env vars are absent', () => {
    original = withoutEnv(USDC_VARS);
    expect(() => createUsdcPaymentRailOrNull()).not.toThrow();
    expect(createUsdcPaymentRailOrNull()).toBeNull();
  });
});
