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
  Rail,
  UsdcTransferIntent,
  WalletResponseInput,
} from './types.js';
import { LAPSE_AT_STAGED_STATUSES, type JobStatus } from '../../domain/job.js';

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

// B23 (bug ledger, C1 rehearsal s7): each leg is only ever eligible while
// the job is in the status that leg belongs to. Shared here, in the
// exempted payment directory, so every door onto the payment surface --
// both rails' /start routes, the USDC wallet-response route, the ABT
// session-mint door (app.ts's requireBuyerToMintAbtSession) and the ABT
// wallet-response callback (abt-did-connect.ts's onAuth) -- applies the
// SAME eligibility rule, rather than each door growing its own copy that
// can silently drift out of sync with the others (Proof round 1, D1 and
// D2 on this card: the token-mint door and onAuth each had their own gate
// missing entirely, because the check lived only in app.ts where those
// two doors could not reach it). The deposit leg settles before confirm
// (confirm's own gate reads it), so it is eligible only at 'proposed';
// the remainder leg settles while the work sits staged and unpaid, the
// exact fact LAPSE_AT_STAGED_STATUSES already names, so it shares that
// set.
const DEPOSIT_ELIGIBLE_STATUSES: ReadonlySet<JobStatus> = new Set(['proposed']);
export function legStatusEligible(leg: RouteLeg, status: JobStatus): boolean {
  return leg === 'deposit' ? DEPOSIT_ELIGIBLE_STATUSES.has(status) : LAPSE_AT_STAGED_STATUSES.has(status);
}
export function legStatusConflictMessage(leg: RouteLeg, status: JobStatus): string {
  const eligible = leg === 'deposit' ? '"proposed"' : '"staged" or "redo_requested"';
  return `the ${leg} leg is not payable while this job is in status "${status}"; it is only payable while the job is ${eligible}`;
}

// B25 (bug ledger, C1 rehearsal s8): each rail's routes refuse a job
// priced on the OTHER rail, in both directions. Shared for the identical
// reason legStatusEligible above is: every door onto the payment surface
// must apply the same rule.
export function legRailMismatchMessage(routeRail: Rail, jobRail: Rail | null): string {
  return `this job is priced on the "${jobRail}" rail; the "${routeRail}" payment routes refuse it`;
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
