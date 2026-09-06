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
export type PaymentRequest = {
  readonly rail: 'abt';
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  // The exact claim shape a DID Connect `claims.prepareTx` callback returns
  // (see abt.ts). P4's route handler returns this verbatim from its own
  // `prepareTx` claim function; nothing here is a route, only data.
  readonly claim: PrepareTxClaim;
};

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
export type WalletResponseInput = {
  readonly rail: 'abt';
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  readonly finalTx: string;
};

// Opaque per rail: what confirm() and every downstream caller address a
// settlement by. ABT: the broadcast transaction hash, plus the two output
// addresses onWalletResponse read out of the finalTx it broadcast, so
// confirm() can check the balances those very outputs paid into (D4,
// Review round 1: confirm previously checked only getTx's code, while the
// card defines confirm as "code OK AND reading the two output balances").
export type PaymentRef = {
  readonly rail: 'abt';
  readonly hash: string;
  readonly operatorAddress: string;
  readonly feeAddress: string;
};

export interface Confirmation {
  readonly rail: Rail;
  readonly hash: string;
  readonly confirmed: boolean;
  // Present once confirmed is true (ABT): the operator's and platform fee
  // address's token balance, read fresh from the chain, in token units.
  readonly operatorBalance?: string;
  readonly feeBalance?: string;
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
