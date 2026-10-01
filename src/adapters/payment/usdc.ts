// USDC payment rail on Arbitrum (MISSION.md invariant 12, this card).
// Driven against a fake chain client and a fake rate source; no test in
// this file ever reaches a real RPC (that happens once, live, outside
// `npm test`, per the card).
//
// ERC-20 has no multi-output transfer (P3 brief, finding 1): one payment
// leg is TWO separate `transfer` calls, price to the operator then fee to
// the platform. The working reference (the operator's wallet-test rig's
// usdc.cjs) proved both transfers land: price 15 USDC to the operator, fee
// 1.2 USDC to the platform, 62,513 gas each, on Arbitrum Sepolia against
// Circle test USDC.
//
// S1 (this card): a confirmed transaction hash used to be the entire
// verification. The chain client now reads the ERC-20 Transfer log's own
// facts (recipient, value, emitting contract, chain id) alongside the
// receipt's status, and `legStatus` (erc20.ts, the token-agnostic ERC-20
// mechanism) binds a leg's confirm answer to those facts
// matching what THIS job's price agreed to, never to "some transaction
// succeeded on this chain". This rail passes it USDC's contract, its chain
// id and its own USDC spent-hash and half-paid tables.
import { USDC_FEE_RATE_PERCENT, calculateFee, toBaseUnits, usdToTokenAmount } from '../../domain/payment.js';
import {
  confirmLegs,
  createErc20ChainClient,
  isValidChainId,
  normalizeTxHash,
  type Erc20ChainClient,
  type Erc20ObservedTransfer,
} from './erc20.js';
import {
  PaymentConfigError,
  RateUnavailableError,
  type Confirmation,
  type CreateRequestInput,
  type PaymentRef,
  type PaymentRequest,
  type Quote,
  type RateSource,
  type UsdcTransferIntent,
  type WalletResponseInput,
} from './types.js';
import { createPrismaUsdcHalfPaidStorage } from './usdc-half-paid-storage-prisma.js';
import type { UsdcHalfPaidStorage, UsdcTransferStatus } from './usdc-half-paid-storage-types.js';
import { createPrismaUsdcSpentTransferStorage } from './usdc-spent-transfer-storage-prisma.js';
import type { UsdcSpentTransferStorage } from './usdc-spent-transfer-storage-types.js';

type UsdcPaymentRequest = Extract<PaymentRequest, { rail: 'usdc' }>;
type UsdcWalletResponseInput = Extract<WalletResponseInput, { rail: 'usdc' }>;
type UsdcPaymentRef = Extract<PaymentRef, { rail: 'usdc' }>;

// The observed Transfer event, the chain client and the hash and chain-id
// helpers live in erc20.ts, which takes the token contract and chain id as
// arguments. They stay importable from this module under their USDC names,
// so src/api/app.ts and the USDC chain-id check in
// src/adapters/config/report.ts import them from here; the ABT-on-Ethereum
// rail (abt-eth.ts) imports from erc20.ts directly.
export type UsdcObservedTransfer = Erc20ObservedTransfer;
export type UsdcChainClient = Erc20ChainClient;
export const normalizeUsdcTxHash = normalizeTxHash;
export const isValidUsdcChainId = isValidChainId;

interface UsdcEnvConfig {
  readonly rpcUrl: string;
  readonly tokenContract: string;
  readonly chainId: number;
  readonly feeAddress: string;
}

// Fails closed BEFORE any network call, matching readAbtEnvConfig's own
// posture (abt.ts): an absent or empty env var throws a typed error
// immediately rather than proceeding with a half-configured rail.
function readUsdcEnvConfig(): UsdcEnvConfig {
  const rpcUrl = process.env.FREEAGENTS_USDC_RPC_URL || '';
  const tokenContract = process.env.FREEAGENTS_USDC_TOKEN_CONTRACT || '';
  const chainIdRaw = process.env.FREEAGENTS_USDC_CHAIN_ID || '';
  const feeAddress = process.env.FREEAGENTS_USDC_FEE_ADDRESS || '';
  const missing = [
    ['FREEAGENTS_USDC_RPC_URL', rpcUrl],
    ['FREEAGENTS_USDC_TOKEN_CONTRACT', tokenContract],
    ['FREEAGENTS_USDC_CHAIN_ID', chainIdRaw],
    ['FREEAGENTS_USDC_FEE_ADDRESS', feeAddress],
  ]
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new PaymentConfigError(`usdc payment rail: missing env var(s): ${missing.join(', ')}`);
  }
  if (!isValidUsdcChainId(chainIdRaw)) {
    throw new PaymentConfigError(
      `usdc payment rail: FREEAGENTS_USDC_CHAIN_ID must be a positive integer, got "${chainIdRaw}"`,
    );
  }
  const chainId = Number.parseInt(chainIdRaw, 10);
  return { rpcUrl, tokenContract, chainId, feeAddress };
}

// USDC is a dollar stablecoin: the honest default rate is 1 dollar per
// USDC. This is an ASSUMPTION ABOUT THE PEG, not a measured rate
// (FACTORY_RULES.md 7.1) -- USDC can and occasionally does trade a hair
// off peg, and nothing here measures that. Callers inject a RateSource for
// tests, or a real one if the peg is ever worth measuring against a feed.
async function defaultRateSource(): Promise<string | null> {
  return '1';
}

export interface CreateUsdcPaymentRailOptions {
  readonly chainClient?: UsdcChainClient;
  readonly rateSource?: RateSource;
  readonly halfPaidStorage?: UsdcHalfPaidStorage;
  readonly spentTransferStorage?: UsdcSpentTransferStorage;
}

export interface UsdcPaymentRailShim {
  readonly rail: 'usdc';
  quote(input: { readonly priceUsd: string }): Promise<Quote>;
  createRequest(input: CreateRequestInput): Promise<UsdcPaymentRequest>;
  onWalletResponse(input: UsdcWalletResponseInput): Promise<UsdcPaymentRef>;
  confirm(ref: UsdcPaymentRef): Promise<Confirmation>;
  // Make 2 (B49 card): the leg's half-paid record, read straight from the
  // rail's own storage, or null when the leg has never gone half-paid.
  // route-support.ts's usdcHalfPaidRecordFor is the one narrow accessor a
  // route file calls; this method exists so that wrapper never has to
  // reach past the rail into halfPaidStorage itself.
  readHalfPaidRecord(jobId: string, leg: 'deposit' | 'balance'): Promise<UsdcHalfPaidRecord | null>;
}

// Make 2: the shape usdc/start answers under its new top-level
// `halfPaidRecord` key. Deliberately NOT named `halfPaid` (types.ts's
// Confirmation already answers a boolean under that exact name, and one
// name must never carry two shapes across this rail's surface).
export interface UsdcHalfPaidRecord {
  readonly priceTxHash: string;
  readonly priceStatus: UsdcTransferStatus;
  readonly feeTxHash: string | null;
  readonly feeStatus: UsdcTransferStatus;
}

// S1: the base-unit amounts a leg's two transfers must carry, computed
// once (onWalletResponse) from the job's own agreed USD amount, the exact
// same quote() + toBaseUnits() path createRequest already used to build
// the transfer intents the wallet signed.
async function expectedBaseUnits(
  amountUsd: string,
  rateSource: RateSource,
  chainClient: UsdcChainClient,
): Promise<{ readonly priceBaseUnits: string; readonly feeBaseUnits: string }> {
  const rate = await rateSource('usdc');
  if (rate === null) {
    throw new RateUnavailableError('usdc');
  }
  const amountToken = usdToTokenAmount(amountUsd, rate);
  const feeUsd = calculateFee(amountUsd, USDC_FEE_RATE_PERCENT);
  const feeToken = usdToTokenAmount(feeUsd, rate);
  const decimals = await chainClient.decimals();
  return {
    priceBaseUnits: toBaseUnits(amountToken, decimals),
    feeBaseUnits: toBaseUnits(feeToken, decimals),
  };
}

export function createUsdcPaymentRail(options: CreateUsdcPaymentRailOptions = {}): UsdcPaymentRailShim {
  const config = readUsdcEnvConfig();
  const chainClient = options.chainClient ?? createErc20ChainClient(config.rpcUrl, config.tokenContract);
  const rateSource = options.rateSource ?? defaultRateSource;
  const halfPaidStorage = options.halfPaidStorage ?? createPrismaUsdcHalfPaidStorage();
  const spentTransferStorage = options.spentTransferStorage ?? createPrismaUsdcSpentTransferStorage();

  return {
    rail: 'usdc',

    async quote(input: { readonly priceUsd: string }): Promise<Quote> {
      const rate = await rateSource('usdc');
      if (rate === null) {
        throw new RateUnavailableError('usdc');
      }
      const amountToken = usdToTokenAmount(input.priceUsd, rate);
      const feeUsd = calculateFee(input.priceUsd, USDC_FEE_RATE_PERCENT);
      const feeToken = usdToTokenAmount(feeUsd, rate);
      return {
        rail: 'usdc',
        priceUsd: input.priceUsd,
        amountToken,
        feeToken,
        rateSource: `injected rate source (dollars per USDC: ${rate})`,
      };
    },

    async createRequest(input: CreateRequestInput): Promise<UsdcPaymentRequest> {
      // Decimals are read from the contract every call, never assumed
      // (P3 brief, mutation proof target): a token at a different
      // precision converts to a different base-unit amount, and this
      // rail must never hardcode 6 even though mainnet and Sepolia USDC
      // both happen to use it.
      const decimals = await chainClient.decimals();
      const priceTransfer: UsdcTransferIntent = {
        recipient: input.operatorAddress,
        amountBaseUnits: toBaseUnits(input.amountToken, decimals),
        tokenContract: config.tokenContract,
      };
      const feeTransfer: UsdcTransferIntent = {
        recipient: config.feeAddress,
        amountBaseUnits: toBaseUnits(input.feeToken, decimals),
        tokenContract: config.tokenContract,
      };
      // Price first, fee second: the web layer raises the two signatures
      // in this order (P3 brief, scope item 2).
      return {
        rail: 'usdc',
        jobId: input.jobId,
        leg: input.leg,
        chainId: config.chainId,
        transfers: [priceTransfer, feeTransfer],
      };
    },

    async onWalletResponse(input: UsdcWalletResponseInput): Promise<UsdcPaymentRef> {
      // Never invent a fee hash for a transfer the wallet never signed
      // (P3 brief, "never report a leg it did not see a receipt for"):
      // feeTxHash is null exactly when input.feeTx.signed is false.
      //
      // S1: the expected base-unit amounts are computed here, ONCE, from
      // the job's own agreed leg amount (input.amountUsd, which the route
      // reads from the job, never from a caller-supplied body field), so
      // confirm() has something to bind the observed transfers against
      // instead of re-deriving an amount or trusting a hash alone.
      const { priceBaseUnits, feeBaseUnits } = await expectedBaseUnits(input.amountUsd, rateSource, chainClient);
      return {
        rail: 'usdc',
        jobId: input.jobId,
        leg: input.leg,
        chainId: config.chainId,
        tokenContract: config.tokenContract,
        operatorAddress: input.operatorAddress,
        feeAddress: config.feeAddress,
        priceTxHash: normalizeUsdcTxHash(input.priceTxHash),
        feeTxHash: input.feeTx.signed ? normalizeUsdcTxHash(input.feeTx.hash) : null,
        expectedPriceBaseUnits: priceBaseUnits,
        expectedFeeBaseUnits: feeBaseUnits,
      };
    },

    async confirm(ref: UsdcPaymentRef): Promise<Confirmation> {
      // The two-transfer confirm, the spent-hash check and the half-paid
      // record are the shared ERC-20 mechanism (erc20.ts), run here against
      // this rail's own chain client and its own USDC storage tables.
      const outcome = await confirmLegs(ref, chainClient, spentTransferStorage, halfPaidStorage);
      return { rail: 'usdc', ...outcome };
    },

    // Make 2 (B49 card): a narrow read of this rail's own half-paid
    // storage, keyed by (jobId, leg). Null when the leg has never gone
    // half-paid; the row shape maps 1:1 onto UsdcHalfPaidRecord, since
    // both are read from and written to the SAME UsdcHalfPaidRow.
    async readHalfPaidRecord(jobId: string, leg: 'deposit' | 'balance') {
      const row = await halfPaidStorage.read(jobId, leg);
      if (row === null) return null;
      return {
        priceTxHash: row.priceTxHash,
        priceStatus: row.priceStatus,
        feeTxHash: row.feeTxHash,
        feeStatus: row.feeStatus,
      };
    },
  };
}
