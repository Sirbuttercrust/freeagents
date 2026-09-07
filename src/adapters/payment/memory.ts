// Memory payment rail: records requests and confirms on command. Built for
// the API tests P4 will write (this card's scope item 6); no real chain
// call ever happens here, and confirm() is driven by the test, not by any
// external truth, so P4 can simulate every leg of the flow deterministically.
import type {
  Confirmation,
  CreateRequestInput,
  PaymentRail,
  PaymentRef,
  PaymentRequest,
  Quote,
  WalletResponseInput,
} from './types.js';

// This rail only ever produces the abt-shaped member of each opaque union
// (see abt.ts's own AbtPaymentRequest/AbtWalletResponseInput/AbtPaymentRef
// comment for why narrowing here, rather than widening the return types,
// is what keeps this file matching P4's existing callers unchanged).
type AbtPaymentRequest = Extract<PaymentRequest, { rail: 'abt' }>;
type AbtWalletResponseInput = Extract<WalletResponseInput, { rail: 'abt' }>;
type AbtPaymentRef = Extract<PaymentRef, { rail: 'abt' }>;

// Test-only control surface, beyond the PaymentRail interface: lets a test
// force a specific confirmation answer for a hash, so P4's API tests can
// simulate "the chain confirmed" or "not yet confirmed" without any real
// broadcast.
export interface MemoryPaymentRailControls {
  setConfirmed(hash: string, confirmed: boolean): void;
}

// Narrowed the same way AbtPaymentRail narrows PaymentRail in abt.ts: this
// rail only ever builds the abt-shaped request/response/ref, so its own
// tests see `.hash`/`.claim` directly rather than a union they would have
// to narrow themselves (P3 added the `usdc` member to the shared types;
// this file's own shape is unchanged).
export interface MemoryPaymentRail extends Omit<PaymentRail, 'createRequest' | 'onWalletResponse' | 'confirm'> {
  readonly rail: 'abt';
  createRequest(input: CreateRequestInput): Promise<AbtPaymentRequest>;
  onWalletResponse(input: AbtWalletResponseInput): Promise<AbtPaymentRef>;
  confirm(ref: AbtPaymentRef): Promise<Confirmation>;
}

export function createMemoryPaymentRail(): MemoryPaymentRail & MemoryPaymentRailControls {
  const confirmations = new Map<string, boolean>();
  let hashCounter = 0;

  return {
    rail: 'abt',

    async quote(input: { readonly priceUsd: string }): Promise<Quote> {
      // A fixed 1:1 rate and zero fee: the memory rail exists for
      // route/API tests that need a deterministic quote, not for pricing
      // correctness (that lives in tests/domain/payment.test.ts and
      // tests/adapters/payment/abt.test.ts).
      return {
        rail: 'abt',
        priceUsd: input.priceUsd,
        amountToken: input.priceUsd,
        feeToken: '0',
        rateSource: 'memory rail: fixed 1:1 rate for tests',
      };
    },

    async createRequest(input: CreateRequestInput): Promise<AbtPaymentRequest> {
      return {
        rail: 'abt',
        jobId: input.jobId,
        leg: input.leg,
        claim: {
          type: 'TransferV3Tx',
          partialTx: {
            from: 'z1MemoryPlatform',
            pk: '0xmemory',
            itx: {
              inputs: [],
              outputs: [
                { owner: input.operatorAddress, tokens: [{ address: 'z1MemoryToken', value: input.amountToken }], assets: [] },
                { owner: 'z1MemoryFeeAddress', tokens: [{ address: 'z1MemoryToken', value: input.feeToken }], assets: [] },
              ],
            },
          },
          requirement: { tokens: [{ address: 'z1MemoryToken', value: input.amountToken }] },
          description: 'memory rail request',
          display: { type: 'text', content: 'memory rail request' },
        },
      };
    },

    async onWalletResponse(input: AbtWalletResponseInput): Promise<AbtPaymentRef> {
      hashCounter += 1;
      const hash = `memory-hash-${input.jobId}-${input.leg}-${String(hashCounter)}`;
      // Unconfirmed by default: a test opts in with setConfirmed.
      confirmations.set(hash, false);
      return {
        rail: 'abt',
        hash,
        operatorAddress: 'z1MemoryOperator',
        feeAddress: 'z1MemoryFeeAddress',
        jobId: input.jobId,
        leg: input.leg,
        expectedOperatorUnit: '0',
        expectedFeeUnit: '0',
      };
    },

    async confirm(ref: AbtPaymentRef): Promise<Confirmation> {
      const confirmed = confirmations.get(ref.hash) ?? false;
      return { rail: 'abt', hash: ref.hash, confirmed };
    },

    setConfirmed(hash: string, confirmed: boolean): void {
      confirmations.set(hash, confirmed);
    },
  };
}
