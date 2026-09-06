// P2: fee math. Pure, no vendor import (invariant 9's domain-purity rule
// applies to this file exactly like every other src/domain file), decimal
// strings in and out, never a JS number carrying money.
//
// Why BigInt and not Number: a JS number is an IEEE754 double, which cannot
// represent every decimal fraction exactly (0.005 stores as
// 0.005000000000000000104083...). Parsing the decimal string into an
// integer "cents-of-the-smallest-unit" BigInt and doing the multiply/divide
// there keeps every digit exact, so a boundary case like 0.005 rounds the
// same way on every machine, forever.
//
// Rounding rule: round-half-up (away from zero) at the cent, chosen because
// it is the rule a buyer expects ("the fee is at least what 3 percent
// looks like when you round it"), not round-half-to-even (which would
// occasionally round a fee down at an exact tie, undercollecting the
// platform's cut) and not truncation (which always undercollects).
// Pinned by the mutation-proof test at the 0.50 * 3% = 0.0150 tie.

// MISSION.md: ABT fee is 3 percent on top of the price at launch.
export const ABT_FEE_RATE_PERCENT = 3;
// MISSION.md: USDC fee is 6 percent on top of the price at launch (P3's
// rail; the constant lives here now so both rails share one fee function
// and cannot drift into two rounding rules).
export const USDC_FEE_RATE_PERCENT = 6;

export class PaymentDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentDomainError';
  }
}

// Parses a decimal string into a BigInt of hundredths (cents), rejecting
// anything that is not a plain non-negative decimal number. No sign, no
// thousands separator, no scientific notation: the same shape job.ts's own
// isDecimalUsd checks, but permissive on the number of decimal places since
// a token amount is not fixed at two places the way priceUsd is.
function parseDecimalToHundredths(value: string, label: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    throw new PaymentDomainError(`${label} must be a non-negative decimal number, got "${value}"`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  // Extra fractional digits beyond the hundredths place are kept in a
  // remainder used only for the round-half-up decision below, never lost
  // silently: '0.005' keeps its third digit as the tie-breaker.
  const hundredths = fraction.slice(0, 2);
  const remainderDigits = fraction.slice(2);
  const remainderIsExactlyHalfOrMore = remainderDigits.length > 0 && Number(remainderDigits[0]) >= 5;
  const base = BigInt(whole) * 100n + BigInt(hundredths === '' ? '0' : hundredths);
  return remainderIsExactlyHalfOrMore ? base + 1n : base;
}

function hundredthsToDecimalString(hundredths: bigint): string {
  const whole = hundredths / 100n;
  const cents = hundredths % 100n;
  return `${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

// Parses a decimal string into a BigInt scaled by 10^scale digits, rounding
// any further fractional digits half-up at that scale. Used for the
// USD-per-token RATE, which (unlike a dollar amount) must survive at more
// than two decimal places: ABT trades in fractions of a cent, so rounding
// the rate to hundredths before dividing (as parseDecimalToHundredths
// would) silently overcharges the buyer at any rate under a whole cent.
// See usdToTokenAmount's header comment.
function parseDecimalScaled(value: string, scale: number, label: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    throw new PaymentDomainError(`${label} must be a non-negative decimal number, got "${value}"`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(scale, '0');
  const kept = fraction.slice(0, scale);
  const remainderDigits = fraction.slice(scale);
  const remainderIsExactlyHalfOrMore = remainderDigits.length > 0 && Number(remainderDigits[0]) >= 5;
  const base = BigInt(whole) * 10n ** BigInt(scale) + BigInt(kept === '' ? '0' : kept);
  return remainderIsExactlyHalfOrMore ? base + 1n : base;
}

// The fee on a price, computed in integer hundredths-of-a-hundredth
// (ten-thousandths) so the round-half-up decision at the final cent is
// exact, then rounded once. rateStr is a percentage of the value (3 means
// 3 percent), passed as an integer to keep every step in BigInt.
export function calculateFee(amountUsd: string, ratePercent: number): string {
  if (!Number.isInteger(ratePercent) || ratePercent < 0) {
    throw new PaymentDomainError(`ratePercent must be a non-negative integer, got ${String(ratePercent)}`);
  }
  const amountHundredths = parseDecimalToHundredths(amountUsd, 'amountUsd');
  // amountHundredths * ratePercent gives hundredths-of-a-percent-unit; the
  // true fee in hundredths is that product divided by 100 (percent) with a
  // round-half-up on the remainder, so the division itself carries the
  // rounding rule rather than truncating it away.
  const scaled = amountHundredths * BigInt(ratePercent);
  const feeHundredths = scaled / 100n;
  const remainder = scaled % 100n;
  const rounded = remainder * 2n >= 100n ? feeHundredths + 1n : feeHundredths;
  return hundredthsToDecimalString(rounded);
}

// Converts a dollar amount to a token amount at an injected rate (dollars
// per token). No floats: the dollar amount is parsed to hundredths-BigInt
// (money is never priced finer than a cent) and the rate is parsed to
// RATE_PRECISION decimal places (D2, review round 1: a rate parsed to
// hundredths like the dollar amount silently rounds a sub-cent ABT rate,
// e.g. $0.0345/ABT, down to $0.03, overcharging the buyer 15 percent). The
// division itself is done as a decimal string via repeated long division,
// so a non-terminating quotient (e.g. 10 / 3) still returns a string rather
// than throwing on an "inexact" BigInt division. The quotient is carried to
// 8 decimal places, matching a token amount's usual precision, then
// trailing zeros are trimmed (never trailing the decimal point itself).
const RATE_PRECISION = 8;

export function usdToTokenAmount(amountUsd: string, usdPerToken: string): string {
  const amountHundredths = parseDecimalToHundredths(amountUsd, 'amountUsd');
  const rateScaled = parseDecimalScaled(usdPerToken, RATE_PRECISION, 'usdPerToken');
  if (rateScaled === 0n) {
    throw new PaymentDomainError('usdPerToken must be greater than zero: a rate of zero has no token amount');
  }
  const PRECISION = 8;
  const scale = 10n ** BigInt(PRECISION);
  // amount is in hundredths (divide by 100) and the rate is scaled by
  // 10^RATE_PRECISION (divide by that scale too); both factors are folded
  // into the numerator/denominator of one division so the quotient is
  // computed once, at PRECISION fractional digits, then formatted.
  const rateScale = 10n ** BigInt(RATE_PRECISION);
  const scaledQuotient = (amountHundredths * rateScale * scale) / (100n * rateScaled);
  const whole = scaledQuotient / scale;
  const fraction = (scaledQuotient % scale).toString().padStart(PRECISION, '0');
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction === '' ? whole.toString() : `${whole.toString()}.${trimmedFraction}`;
}

// Converts a decimal token amount to its integer smallest-unit string at
// `decimals` places (P3, USDC: 6, read from the contract, never assumed).
// Rounding convention: FLOOR, never round-half-up. Chosen so a buyer is
// never asked to sign a base-unit amount larger than the exact quoted
// price, matching the direction usdToTokenAmount already errs in at its own
// 8-decimal-place limit (that function's header comment): the platform
// would rather collect a fraction of a base unit less than owed than ask a
// wallet to sign more than it was quoted. A fraction of a base unit is
// worth a fraction of a cent even at USDC's own precision, so this favours
// the buyer, never the operator or the platform. Excess fractional digits
// beyond `decimals` are simply dropped (truncated), not rounded either
// direction, which is what "floor" means for a non-negative amount.
export function toBaseUnits(amountToken: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new PaymentDomainError(`decimals must be a non-negative integer, got ${String(decimals)}`);
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amountToken.trim());
  if (match === null) {
    throw new PaymentDomainError(`amountToken must be a non-negative decimal number, got "${amountToken}"`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(decimals, '0').slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction === '' ? '0' : fraction)).toString();
}
