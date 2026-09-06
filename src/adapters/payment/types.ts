// Payment capability (MISSION.md invariant 12, "Buyer to operator, never
// through us"): the interface every settlement rail implements. Rail-agnostic
// on purpose, so P3 (USDC) fits without changing this file. ABT is built to
// this shape first (this card); PaymentRequest and PaymentRef are opaque
// discriminated unions on `rail`, so a caller never branches on a
// rail-specific field it does not recognise.
//
// What this card builds and what it does not: the protocol LOGIC (claim
// shape, wallet-response processing, broadcast, confirm) lives here,
// rail-agnostic and independently testable against a fake chain client. The
// Express wiring that makes DID Connect actually reachable over HTTP
// (`WalletAuthenticator` + `WalletHandlers.attach()`, the `txEncoder`, the
// route that calls `onWalletResponse` with what the wallet posted back) is
// explicitly out of scope here ("No routes in this card. No state changes on
// Job. P4 wires it."). `AbtPaymentRail.buildPrepareTxClaim` is the seam P4's
// `claims.prepareTx` callback calls straight through, so the claim shape
// this card tests is the exact claim shape P4 ships (see abt.ts's header
// comment for the fuller reasoning; recorded as an assumption per
// FACTORY_RULES.md 7.1, a product value, not a judgement value).

export type Rail = 'abt' | 'usdc';

export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigError';
  }
}

// Thrown by quote() when no rate source answers. The route surfaces this
// rather than quoting a stale or invented number (brief scope item 3).
export class RateUnavailableError extends Error {
  constructor(rail: Rail) {
    super(`no rate is available for rail "${rail}"`);
    this.name = 'RateUnavailableError';
  }
}

// Injected so tests never hit the network (brief scope item 3): returns
// dollars-per-token for the named rail, or null when no rate can be read.
// The production default's source is named in abt.ts's header comment.
export type RateSource = (rail: Rail) => Promise<string | null>;

export interface Quote {
  readonly rail: Rail;
  readonly priceUsd: string;
  // The price converted to token units at the quoted rate.
  readonly amountToken: string;
  // The platform fee in token units, ON TOP of amountToken (never deducted
  // from it): MISSION.md, "the operator receives the signed price".
  readonly feeToken: string;
  // Names where the USD-per-token rate came from, so a quote is never a
  // number with no accountable source.
  readonly rateSource: string;
}

export interface CreateRequestInput {
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  readonly operatorAddress: string;
  readonly amountToken: string;
  readonly feeToken: string;
}

// What the web layer needs to show a scan. Opaque per rail: a caller reads
// `rail` to pick a renderer and passes everything else through unexamined,
// so P3 can add a `usdc` member without this card's callers changing.
export type PaymentRequest =
  | {
      readonly rail: 'abt';
      readonly jobId: string;
      readonly leg: 'deposit' | 'balance';
      // The exact claim shape a DID Connect `claims.prepareTx` callback returns
      // (see abt.ts). P4's route handler returns this verbatim from its own
      // `prepareTx` claim function; nothing here is a route, only data.
      readonly claim: PrepareTxClaim;
    }
  | {
      readonly rail: 'usdc';
      readonly jobId: string;
      readonly leg: 'deposit' | 'balance';
      readonly chainId: number;
      // ERC-20 has no multi-output transfer (P3's brief, finding 1): one
      // payment leg is two separate `transfer` calls, price to the operator
      // then fee to the platform, in the order the web layer must raise the
      // two signatures. A tuple, not an array, so a caller cannot receive
      // zero or three of these by construction.
      readonly transfers: readonly [UsdcTransferIntent, UsdcTransferIntent];
    };

// One ERC-20 `transfer(recipient, amount)` call the web layer renders as a
// signature request. amountBaseUnits is the token's own smallest unit
// (never a decimal token amount), a string because it can exceed
// Number.MAX_SAFE_INTEGER and must never round.
export interface UsdcTransferIntent {
  readonly recipient: string;
  readonly amountBaseUnits: string;
  readonly tokenContract: string;
}

// The prepareTx claim shape the working reference proved on the ABT beta
// chain (qr-server.mjs, hash F3209229A6E6FED27463F2A908C1C94C49E622FE55CA74A160C1C6871AFE55FA).
export interface PrepareTxClaim {
  readonly type: 'TransferV3Tx';
  readonly partialTx: {
    readonly from: string;
    readonly pk: string;
    readonly itx: {
      readonly inputs: readonly unknown[];
      readonly outputs: readonly [
        { readonly owner: string; readonly tokens: readonly [{ readonly address: string; readonly value: string }]; readonly assets: readonly [] },
        { readonly owner: string; readonly tokens: readonly [{ readonly address: string; readonly value: string }]; readonly assets: readonly [] },
      ];
    };
  };
  readonly requirement: { readonly tokens: readonly [{ readonly address: string; readonly value: string }] };
  readonly description: string;
  readonly display: { readonly type: 'text'; readonly content: string };
}

// What the wallet hands back, opaque per rail. ABT: the finalTx the wallet
// signed (base58, exactly what DID Connect's `signature` claim answer
// carries as `c.finalTx` in the working reference).
export type WalletResponseInput =
  | {
      readonly rail: 'abt';
      readonly jobId: string;
      readonly leg: 'deposit' | 'balance';
      readonly finalTx: string;
    }
  | {
      readonly rail: 'usdc';
      readonly jobId: string;
      readonly leg: 'deposit' | 'balance';
      // The operator address this leg's price transfer was addressed to
      // (the same value createRequest's CreateRequestInput carried): USDC
      // has no envelope-signing platform step to independently decode an
      // address from the way ABT's onWalletResponse does (see abt.ts), so
      // the caller (P4's route handler, which already built the request)
      // passes it back through rather than this rail re-deriving it.
      readonly operatorAddress: string;
      // The buyer always signs the price transfer first (createRequest's
      // transfer order): a hash always exists for it by the time this is
      // called.
      readonly priceTxHash: string;
      // The fee transfer's outcome. An explicit "the wallet never signed
      // it" answer, not an empty string or a null hash standing in for
      // one: this rail must never guess why a hash is missing (P3 brief,
      // scope item 2).
      readonly feeTx: { readonly signed: true; readonly hash: string } | { readonly signed: false };
      // S1: the leg's agreed USD amount (route's legAmountUsdFromJob),
      // carried through so onWalletResponse can compute the base-unit
      // amounts confirm() must bind the observed transfers against. Never
      // read from a caller-supplied body field at the route (S1 brief,
      // "the amount must come from the job's agreed price"); this is the
      // rail's own input contract, not a route body shape.
      readonly amountUsd: string;
    };

// Opaque per rail: what confirm() and every downstream caller address a
// settlement by. ABT: the broadcast transaction hash, plus the two output
// addresses onWalletResponse read out of the finalTx it broadcast, so
// confirm() can check the balances those very outputs paid into (D4,
// Review round 1: confirm previously checked only getTx's code, while the
// card defines confirm as "code OK AND reading the two output balances").
export type PaymentRef =
  | {
      readonly rail: 'abt';
      readonly hash: string;
      readonly operatorAddress: string;
      readonly feeAddress: string;
    }
  | {
      readonly rail: 'usdc';
      readonly jobId: string;
      readonly leg: 'deposit' | 'balance';
      readonly chainId: number;
      readonly tokenContract: string;
      readonly operatorAddress: string;
      readonly feeAddress: string;
      readonly priceTxHash: string;
      // null exactly when the wallet never signed the fee transfer
      // (WalletResponseInput's `feeTx: { signed: false }`): confirm() must
      // never invent a hash to check a receipt for one that was never sent.
      readonly feeTxHash: string | null;
      // S1: the base-unit amounts the price and fee transfers must carry
      // to confirm, computed once by onWalletResponse from the job's own
      // agreed USD price (never a caller-supplied amount). confirm()
      // compares each observed transfer's value against these, never
      // against a fresh re-quote: the price a buyer signed for is the
      // price that must land, even if the rate source answers something
      // else by the time confirm() runs.
      readonly expectedPriceBaseUnits: string;
      readonly expectedFeeBaseUnits: string;
    };

// Per-leg outcome confirm() actually observed on chain, USDC only. Four
// states, not two, because "the wallet never signed this", "signed and
// broadcast but the chain has not confirmed it", and "landed, but paid the
// wrong recipient, amount, token or chain" are three different facts and a
// caller acting on any of them must be able to tell them apart (S1: a
// transaction that succeeded is not the same fact as a transaction that
// paid what this job asked for).
export type UsdcLegStatus =
  | { readonly status: 'confirmed'; readonly hash: string }
  | { readonly status: 'not_confirmed'; readonly hash: string }
  | { readonly status: 'not_signed' }
  | { readonly status: 'mismatched'; readonly hash: string };

export interface Confirmation {
  readonly rail: Rail;
  // ABT: the single broadcast tx hash. USDC: the price transfer's hash,
  // which always exists by the time confirm() is called (see
  // WalletResponseInput above).
  readonly hash: string;
  readonly confirmed: boolean;
  // Present once confirmed is true (ABT): the operator's and platform fee
  // address's token balance, read fresh from the chain, in token units.
  readonly operatorBalance?: string;
  readonly feeBalance?: string;
  // USDC only: each leg's own observed status, so a caller never has to
  // infer what happened to the fee transfer from `confirmed: false` alone
  // (P3 brief, "never report a leg it did not see a receipt for").
  readonly legs?: { readonly price: UsdcLegStatus; readonly fee: UsdcLegStatus };
  // True exactly when one leg confirmed and the other did not (whichever
  // direction): the half-paid state this card exists to name plainly
  // rather than silently reporting `confirmed: false` and leaving a caller
  // to guess why.
  readonly halfPaid?: boolean;
}

export interface PaymentRail {
  readonly rail: Rail;
  quote(input: { readonly priceUsd: string }): Promise<Quote>;
  createRequest(input: CreateRequestInput): Promise<PaymentRequest>;
  onWalletResponse(input: WalletResponseInput): Promise<PaymentRef>;
  // Idempotent: confirming the same ref twice returns the same answer and
  // never broadcasts or re-checks in a way that could disagree with itself.
  confirm(ref: PaymentRef): Promise<Confirmation>;
}
