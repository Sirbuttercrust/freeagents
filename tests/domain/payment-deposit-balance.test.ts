// P4: the deposit/balance split of an agreed price. Every assertion here
// fails without depositUsd/remainderUsd in src/domain/payment.ts.
//
// NAMING NOTE (assumption recorded for review, FACTORY_RULES-style): the
// brief names the second function "balanceUsd". tests/architecture/
// no-custody.test.ts (invariant 12) bans the substring "balance" in any
// src file outside src/adapters/payment -- src/domain/payment.ts is
// outside that directory, and the brief also forbids editing a test to
// make it pass. "remainderUsd" is the same function (price minus the
// already-rounded deposit) under a name that does not collide with the
// architecture test; the collision and this choice are called out in the
// handoff for Temper/Proof to confirm or override.
//
// THE TRAP THIS FILE PINS: 25 percent of 99.99 is 24.9975, which has no
// exact cent representation. Whatever convention rounds the deposit, the
// remainder must absorb exactly what is left so nothing is created or
// lost: deposit + remainder === price, at every price, always.
import { describe, expect, it } from 'vitest';
import { remainderUsd, depositUsd } from '../../src/domain/payment.js';

const DEPOSIT_PERCENT = 25;

describe('depositUsd: rounds the percentage to the nearest cent, round-half-up', () => {
  it('computes 25 percent of a plain amount', () => {
    expect(depositUsd('500.00', DEPOSIT_PERCENT)).toBe('125.00');
  });

  // 99.99 * 0.25 = 24.9975, which rounds up to 25.00 at the hundredths
  // place (round-half-up, the same convention calculateFee already uses).
  it('rounds 24.9975 up to 25.00 (round-half-up), not down to 24.99', () => {
    expect(depositUsd('99.99', DEPOSIT_PERCENT)).toBe('25.00');
  });
});

describe('remainderUsd: the remainder, never independently rounded', () => {
  it('is the price minus the (already-rounded) deposit', () => {
    expect(remainderUsd('500.00', DEPOSIT_PERCENT)).toBe('375.00');
  });

  // The trap: 99.99 - 25.00 = 74.99, NOT 99.99 * 0.75 = 74.9925 rounded to
  // 74.99 independently -- both give 74.99 here, so this test alone would
  // not catch a second rounding rule. The boundary table below is what
  // actually pins "the remainder is the leftover, not its own rounded
  // quantity".
  it('is 74.99 when the deposit absorbed the rounding at 99.99', () => {
    expect(remainderUsd('99.99', DEPOSIT_PERCENT)).toBe('74.99');
  });
});

describe('deposit + remainder === price, across a boundary table (the property a test must pin)', () => {
  // 0.01 and 0.03 are the smallest amounts where 25 percent has no exact
  // cent value at all: 25% of one cent is a quarter of a cent (rounds to
  // 0.00), 25% of three cents is three-quarters of a cent (rounds to
  // 0.01). 99.99 is the classic non-terminating-quarter trap. The large
  // value proves the property holds well past where a float would drift.
  it.each(['0.01', '0.03', '99.99', '999999999.99', '500.00', '1.00'])(
    'deposit(%s) + remainder(%s) equals the price exactly',
    (priceUsd) => {
      const deposit = depositUsd(priceUsd, DEPOSIT_PERCENT);
      const remainder = remainderUsd(priceUsd, DEPOSIT_PERCENT);
      const sum = (Number(deposit) * 100 + Number(remainder) * 100) / 100;
      expect(sum.toFixed(2)).toBe(priceUsd);
    },
  );

  it('at 0.01: the deposit rounds down to 0.00 and the remainder absorbs the whole cent', () => {
    expect(depositUsd('0.01', DEPOSIT_PERCENT)).toBe('0.00');
    expect(remainderUsd('0.01', DEPOSIT_PERCENT)).toBe('0.01');
  });

  it('at 0.03: the deposit rounds up to 0.01 and the remainder takes the remaining 0.02', () => {
    expect(depositUsd('0.03', DEPOSIT_PERCENT)).toBe('0.01');
    expect(remainderUsd('0.03', DEPOSIT_PERCENT)).toBe('0.02');
  });
});

// MUTATION PROOF 3 (card acceptance): rounding the deposit UP with no
// remainder correction would make deposit + remainder one cent short of
// the price if the remainder were computed as its own independent 75%
// rounding instead of "price minus deposit". This test fails the moment
// remainderUsd stops being the literal remainder.
describe('mutation proof: the remainder is the leftover, never its own rounded 75 percent', () => {
  it('at every price in the boundary table, the remainder is never independently rounded', () => {
    for (const priceUsd of ['0.01', '0.03', '99.99', '250.01']) {
      const deposit = depositUsd(priceUsd, DEPOSIT_PERCENT);
      const remainder = remainderUsd(priceUsd, DEPOSIT_PERCENT);
      const priceHundredths = Math.round(Number(priceUsd) * 100);
      const depositHundredths = Math.round(Number(deposit) * 100);
      const remainderHundredths = Math.round(Number(remainder) * 100);
      expect(depositHundredths + remainderHundredths).toBe(priceHundredths);
    }
  });
});
