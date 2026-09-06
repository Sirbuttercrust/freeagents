// P10: the payment-safe route helpers (brief, "the two banned substrings").
// tests/architecture/no-custody.test.ts bans /transfer|payout|balance|
// custody|refund|charge|escrow/i on any non-comment line in any src file
// OUTSIDE src/adapters/payment. The route layer (src/api/app.ts) needs to
// name the remainder leg and read the USDC two-transfer tuple without
// ever writing either banned word itself. remainderSettled() in gate.ts
// is the established precedent: a wrapper that lives INSIDE this exempted
// directory so the route layer never has to write the word. This file is
// the same answer for the payment surface routes.
import type {
  Confirmation,
  CreateRequestInput,
  PaymentRail,
  PaymentRef,
  PaymentRequest,
  UsdcTransferIntent,
  WalletResponseInput,
} from './types.js';

// The route-safe leg name. 'remainder', never 'balance': see the header
// comment above and src/domain/payment.ts's identically-named
// remainderUsd for the same reason.
export type RouteLeg = 'deposit' | 'remainder';

function toRailLeg(leg: RouteLeg): CreateRequestInput['leg'] {
  return leg === 'remainder' ? 'balance' : 'deposit';
}

function toRouteLeg(leg: CreateRequestInput['leg']): RouteLeg {
  return leg === 'balance' ? 'remainder' : 'deposit';
}

// Wraps rail.createRequest so the route layer supplies 'deposit' |
// 'remainder' and never writes the literal 'balance' itself.
export async function requestPayment(
  rail: PaymentRail,
  input: {
    readonly jobId: string;
    readonly leg: RouteLeg;
    readonly operatorAddress: string;
    readonly amountToken: string;
    readonly feeToken: string;
  },
): Promise<PaymentRequest> {
  return rail.createRequest({ ...input, leg: toRailLeg(input.leg) });
}

// Wraps rail.onWalletResponse for the same reason: the caller supplies a
// route-safe leg, this file is the only place that ever writes the rail's
// internal 'balance' spelling.
export async function processWalletResponse(
  rail: PaymentRail,
  leg: RouteLeg,
  input: Omit<Extract<WalletResponseInput, { rail: 'abt' }>, 'leg' | 'rail'> & { readonly rail: 'abt' },
): Promise<PaymentRef>;
export async function processWalletResponse(
  rail: PaymentRail,
  leg: RouteLeg,
  input: Omit<Extract<WalletResponseInput, { rail: 'usdc' }>, 'leg' | 'rail'> & { readonly rail: 'usdc' },
): Promise<PaymentRef>;
export async function processWalletResponse(
  rail: PaymentRail,
  leg: RouteLeg,
  input: Omit<WalletResponseInput, 'leg'>,
): Promise<PaymentRef> {
  return rail.onWalletResponse({ ...input, leg: toRailLeg(leg) } as WalletResponseInput);
}

// The route-safe leg a ref or request actually carries, read once, here,
// so a route file never has to compare against the literal 'balance'.
export function routeLegOf(value: { readonly leg: CreateRequestInput['leg'] }): RouteLeg {
  return toRouteLeg(value.leg);
}

// USDC only: the two transfer intents as a route-safe accessor, so a
// route file never writes `.transfers` or names a variable `transfers`
// (the brief's own named trap).
export function usdcTransferIntents(
  request: Extract<PaymentRequest, { rail: 'usdc' }>,
): readonly [UsdcTransferIntent, UsdcTransferIntent] {
  return request.transfers;
}

// confirm() is payment-safe already (Confirmation carries no banned
// vocabulary), so this is a plain passthrough kept here for symmetry: the
// route layer calls one small set of functions from this file for every
// rail interaction, rather than mixing direct rail calls with wrapped
// ones.
export async function confirmPayment(rail: PaymentRail, ref: PaymentRef): Promise<Confirmation> {
  return rail.confirm(ref);
}
