// P2: fee math, pure, decimal strings, no floats. Every assertion here fails
// without src/domain/payment.ts and passes with it.
import { describe, expect, it } from 'vitest';
import {
  ABT_FEE_RATE_PERCENT,
  USDC_FEE_RATE_PERCENT,
  calculateFee,
  coversAgreedUsd,
  toBaseUnits,
  tokenAmountWorthUsd,
  usdToTokenAmount,
} from '../../src/domain/payment.js';

describe('calculateFee: decimal-string math, never a JS float', () => {
  it('computes 3 percent of a plain amount, rounded to two places', () => {
    expect(calculateFee('500.00', ABT_FEE_RATE_PERCENT)).toBe('15.00');
  });

  it('a tiny amount below one cent of fee rounds down to 0.00', () => {
    // 0.01 * 0.03 = 0.0003, which is not exactly representable as an IEEE754
    // double either, but rounds the same way any implementation would.
    expect(calculateFee('0.01', ABT_FEE_RATE_PERCENT)).toBe('0.00');
  });

  it('an amount with three decimal digits is read exactly, not through a float', () => {
    // 0.005 has no exact IEEE754 double representation (it stores as
    // 0.005000000000000000104083...). A `Number('0.005') * 0.03` computation
    // would carry that drift into the result. This function parses the
    // decimal string digit-by-digit through BigInt, so the boundary is
    // exact: 0.005 is first rounded up to the nearest cent, 0.01 (the
    // ROUNDING happens on the INPUT, at the hundredths place, before any
    // fee percentage is applied), and 3 percent of 0.01 is 0.0003, which
    // itself rounds down to 0.00. Pinned separately below at a rate where
    // the two rules (round-the-input-first vs. round-the-fee-only) give
    // different answers, so this boundary cannot silently regress into
    // "round-half-up" being a no-op.
    expect(calculateFee('0.005', ABT_FEE_RATE_PERCENT)).toBe('0.00');
  });

  it('a large amount does not lose precision the way a double would', () => {
    // 123456789.87654321 has 17 significant digits, past a double's ~15-17
    // digit reliable range. BigInt arithmetic carries every digit exactly.
    expect(calculateFee('123456789.87654321', ABT_FEE_RATE_PERCENT)).toBe('3703703.70');
  });

  // MUTATION PROOF: the rounding rule is round-half-up (away from zero), not
  // round-half-to-even (banker's) and not truncation. 0.50 * 0.03 = 0.0150
  // cents-of-a-cent math lands exactly on a half-cent tie (1.5 cents); a
  // truncating implementation answers 0.01, a round-half-up implementation
  // answers 0.02. Pinning the tie catches a dropped "round up on exact half".
  it('an amount landing exactly on a half-cent fee rounds up (round-half-up, not truncation)', () => {
    expect(calculateFee('0.50', ABT_FEE_RATE_PERCENT)).toBe('0.02');
  });

  // The 0.005 boundary above is NOT actually pinned,
  // because rounding the INPUT up to a whole cent and rounding the FEE up
  // on a tie give the same answer at that one amount (both land on 0.00).
  // 0.165 tells the two rules apart: round-the-input-first takes 0.165 to
  // 0.17 before applying 3 percent (0.17 * 0.03 = 0.0051, rounds to 0.01);
  // a rule that instead kept the input exact and rounded only the final
  // fee would compute 0.165 * 0.03 = 0.00495, which rounds to 0.00. This
  // is what distinguishes the documented behaviour from a deleted comment.
  it('an input rounded up at the hundredths place changes the fee versus keeping the input exact (0.165 boundary)', () => {
    expect(calculateFee('0.165', ABT_FEE_RATE_PERCENT)).toBe('0.01');
  });

  it('rejects a malformed amount rather than silently returning zero', () => {
    expect(() => calculateFee('not-a-number', ABT_FEE_RATE_PERCENT)).toThrow();
  });

  it('rejects a negative amount: a fee on negative money is not a fee this domain models', () => {
    expect(() => calculateFee('-5.00', ABT_FEE_RATE_PERCENT)).toThrow();
  });
});

describe('calculateFee at the USDC rate (6 percent, P3): the same round-half-up rule applies at a different rate', () => {
  it('computes 6 percent of a plain amount', () => {
    expect(calculateFee('20.00', USDC_FEE_RATE_PERCENT)).toBe('1.20');
  });

  // MUTATION PROOF (P3, "round the 6 percent fee the wrong way at the
  // boundary"): 0.25 * 6% = 0.0150, an exact half-cent tie at the 6 percent
  // rate (a different tie than ABT's 0.50 * 3% one, since 6 percent and 3
  // percent land on a tie at different amounts). Round-half-up answers
  // 0.02; truncation answers 0.01.
  it('an amount landing exactly on a half-cent fee at 6 percent rounds up (round-half-up, not truncation)', () => {
    expect(calculateFee('0.25', USDC_FEE_RATE_PERCENT)).toBe('0.02');
  });
});

describe('usdToTokenAmount: dollar amount converted at an injected rate, decimal strings only', () => {
  it('divides the dollar amount by the USD-per-token rate', () => {
    // $2.06 at a rate of $1 per token is 2.06 tokens.
    expect(usdToTokenAmount('2.06', '1.00')).toBe('2.06');
  });

  it('divides correctly at a fractional rate', () => {
    // $10.00 at $0.50 per token is 20 tokens.
    expect(usdToTokenAmount('10.00', '0.50')).toBe('20');
  });

  it('rejects a zero rate: division by zero is not a token amount', () => {
    expect(() => usdToTokenAmount('10.00', '0')).toThrow();
  });

  // The USD-per-token rate used to be parsed through
  // the same hundredths-only parser as a dollar amount, so a rate like
  // $0.0345/ABT was rounded to $0.03 before the division ever ran. ABT
  // trades at fractions of a cent, so the rate must be carried at full
  // precision. This is the exact case the prior test suite had no example
  // of (it only ever used '1.00' and '0.50', both exact at two places).
  it('carries a sub-cent rate at full precision instead of rounding it to the nearest cent first', () => {
    // Ground truth: 500 / 0.0345 = 14492.753623188405... The old
    // rounds-rate-to-cents behaviour answered 16666.66666666 (500 / 0.03),
    // a 15 percent overpayment in the buyer's direction.
    expect(usdToTokenAmount('500.00', '0.0345')).toBe('14492.75362318');
  });

  it('two rates that round to the same cent value produce different token amounts', () => {
    // $0.0345 and $0.03 both round to $0.03 under a hundredths-only parse.
    // At full precision they must diverge.
    const atFullRate = usdToTokenAmount('500.00', '0.0345');
    const atRoundedRate = usdToTokenAmount('500.00', '0.03');
    expect(atFullRate).not.toBe(atRoundedRate);
    expect(atRoundedRate).toBe('16666.66666666');
  });

  it('accepts a rate below half a cent rather than throwing "must be greater than zero"', () => {
    // Under the old hundredths-only parser, any rate below $0.005 rounded
    // down to zero and then threw the zero-rate guard on a legitimate,
    // merely-small rate.
    expect(() => usdToTokenAmount('10.00', '0.004')).not.toThrow();
    expect(usdToTokenAmount('10.00', '0.004')).toBe('2500');
  });
});

describe('toBaseUnits: decimal token amount to integer smallest-unit, floor convention (P3)', () => {
  it('converts a whole-number token amount at 6 decimals (USDC)', () => {
    expect(toBaseUnits('15', 6)).toBe('15000000');
  });

  it('converts a fractional token amount that divides exactly at the target precision', () => {
    expect(toBaseUnits('1.2', 6)).toBe('1200000');
  });

  // MUTATION PROOF (P3, "settle the rounding convention deliberately"):
  // FLOOR, not round-half-up, chosen so the buyer is never asked to sign a
  // base-unit amount larger than the exact quoted price (consistent with
  // usdToTokenAmount's own floor at its 8-decimal-place limit, so the whole
  // USD -> token -> base-units pipeline errs in one direction only). This
  // amount's 7th decimal digit is a genuine tie-breaker (5, not merely
  // trailing), so round-half-up and floor answer differently: round-half-up
  // would take 15123457, floor takes 15123456.
  it('floors excess fractional digits beyond the target precision (round-half-up would answer differently)', () => {
    expect(toBaseUnits('15.1234565', 6)).toBe('15123456');
  });

  it('floors even when the excess digit is a 9 (never rounds up regardless of magnitude)', () => {
    expect(toBaseUnits('0.0000009', 6)).toBe('0');
  });

  it('rejects a malformed amount rather than silently returning zero', () => {
    expect(() => toBaseUnits('not-a-number', 6)).toThrow();
  });

  it('rejects a negative decimals count', () => {
    expect(() => toBaseUnits('15', -1)).toThrow();
  });
});

// What a held token amount is worth at a rate read later. The worth is
// floored at 8 decimal places, so a payment that is short is never called
// full by rounding.
describe('tokenAmountWorthUsd: the dollar value of a token amount, in BigInt over decimal strings', () => {
  it('answers 20 for 80 tokens at 0.25 dollars each', () => {
    expect(tokenAmountWorthUsd('80', '0.25')).toBe('20');
  });

  it('keeps the fraction of a worth that is not whole dollars, trailing zeros trimmed', () => {
    expect(tokenAmountWorthUsd('1000', '0.01234567')).toBe('12.34567');
  });

  it('reads a rate written to 8 fractional digits exactly', () => {
    expect(tokenAmountWorthUsd('400000000', '0.00000025')).toBe('100');
    expect(tokenAmountWorthUsd('123.45678901', '0.12345678')).toBe('15.24157764');
  });

  it('answers 0 for a zero amount', () => {
    expect(tokenAmountWorthUsd('0', '0.25')).toBe('0');
  });

  it('floors the worth at 8 places: one smallest unit of an 18-decimal token short of 80 is worth 19.99999999, not 20', () => {
    // 79.999999999999999999 * 0.25 = 19.99999999999999999975 exactly.
    expect(tokenAmountWorthUsd('79.999999999999999999', '0.25')).toBe('19.99999999');
  });

  it('floors a worth whose ninth digit is a 9 instead of rounding it up to a whole dollar', () => {
    expect(tokenAmountWorthUsd('1', '0.999999999')).toBe('0.99999999');
  });

  it('refuses a malformed amount or rate', () => {
    expect(() => tokenAmountWorthUsd('abc', '0.25')).toThrow('amountToken must be a non-negative decimal number, got "abc"');
    expect(() => tokenAmountWorthUsd('80', '-1')).toThrow('usdPerToken must be a non-negative decimal number, got "-1"');
  });
});

describe('coversAgreedUsd: is the amount still worth at least the agreed dollars at this rate', () => {
  it('covers when the amount is worth exactly the agreed price', () => {
    expect(coversAgreedUsd('80', '0.25', '20.00')).toBe(true);
  });

  it('does not cover when the amount is one smallest unit of an 18-decimal token less than the agreed price needs', () => {
    expect(coversAgreedUsd('79.999999999999999999', '0.25', '20.00')).toBe(false);
  });

  it('covers when the amount is worth more than the agreed price', () => {
    expect(coversAgreedUsd('80.000000000000000001', '0.25', '20.00')).toBe(true);
    expect(coversAgreedUsd('80', '0.26', '20.00')).toBe(true);
  });

  it('does not cover when the rate fell', () => {
    expect(coversAgreedUsd('80', '0.24', '20.00')).toBe(false);
  });

  it('judges a rate with 8 fractional digits exactly, at the boundary', () => {
    expect(coversAgreedUsd('400000000', '0.00000025', '100.00')).toBe(true);
    expect(coversAgreedUsd('399999999.999999999999999999', '0.00000025', '100.00')).toBe(false);
  });

  it('covers 3 tokens at 0.29 for 0.87, where floating point answers 0.8699999999999999 and calls it short', () => {
    // 3 * 0.29 is 0.8699999999999999 as an IEEE754 double and 0.87 in exact
    // arithmetic. 3 * 0.35 is 1.0499999999999998 against an exact 1.05.
    expect(coversAgreedUsd('3', '0.29', '0.87')).toBe(true);
    expect(coversAgreedUsd('3', '0.35', '1.05')).toBe(true);
  });

  it('does not call a value that rounds up to the agreed price full: 0.999999999 worth is short of 1.00', () => {
    expect(coversAgreedUsd('1', '0.999999999', '1.00')).toBe(false);
  });

  it('refuses an agreed price that is not a decimal amount', () => {
    expect(() => coversAgreedUsd('80', '0.25', 'twenty')).toThrow('agreedUsd must be a non-negative decimal number, got "twenty"');
  });
});
