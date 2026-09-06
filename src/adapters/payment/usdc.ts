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
import { Contract, JsonRpcProvider } from 'ethers';
import { USDC_FEE_RATE_PERCENT, calculateFee, toBaseUnits, usdToTokenAmount } from '../../domain/payment.js';
import {
  PaymentConfigError,
  RateUnavailableError,
  type Confirmation,
  type CreateRequestInput,
  type PaymentRef,
  type PaymentRequest,
  type Quote,
  type RateSource,
  type UsdcLegStatus,
  type UsdcTransferIntent,
  type WalletResponseInput,
} from './types.js';
import { createPrismaUsdcHalfPaidStorage } from './usdc-half-paid-storage-prisma.js';
import type { UsdcHalfPaidStorage } from './usdc-half-paid-storage-types.js';

type UsdcPaymentRequest = Extract<PaymentRequest, { rail: 'usdc' }>;
type UsdcWalletResponseInput = Extract<WalletResponseInput, { rail: 'usdc' }>;
type UsdcPaymentRef = Extract<PaymentRef, { rail: 'usdc' }>;

// The one chain call this rail needs before broadcast: reading the token's
// own decimals (P3 brief, "read token decimals from the contract; do not
// hardcode 6"), isolated behind an interface so tests never construct a
// real ethers Provider (no network in the test suite; FACTORY_RULES.md and
// this card both require that). The production default wraps a real
// ethers JsonRpcProvider + Contract.
export interface UsdcChainClient {
  decimals(): Promise<number>;
  getTransactionReceipt(hash: string): Promise<{ readonly status: number | null } | null>;
}

function realChainClient(rpcUrl: string, tokenContract: string): UsdcChainClient {
  const provider = new JsonRpcProvider(rpcUrl);
  const erc20Abi = ['function decimals() view returns (uint8)'];
  const contract = new Contract(tokenContract, erc20Abi, provider);
  const decimalsFn = contract.getFunction('decimals');
  return {
    decimals: async () => Number(await decimalsFn()),
    getTransactionReceipt: async (hash) => provider.getTransactionReceipt(hash),
  };
}

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
  const chainId = Number.parseInt(chainIdRaw, 10);
  if (!Number.isInteger(chainId) || chainId <= 0 || String(chainId) !== chainIdRaw) {
    throw new PaymentConfigError(
      `usdc payment rail: FREEAGENTS_USDC_CHAIN_ID must be a positive integer, got "${chainIdRaw}"`,
    );
  }
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
}

export interface UsdcPaymentRailShim {
  readonly rail: 'usdc';
  quote(input: { readonly priceUsd: string }): Promise<Quote>;
  createRequest(input: CreateRequestInput): Promise<UsdcPaymentRequest>;
  onWalletResponse(input: UsdcWalletResponseInput): Promise<UsdcPaymentRef>;
  confirm(ref: UsdcPaymentRef): Promise<Confirmation>;
}

export function createUsdcPaymentRail(options: CreateUsdcPaymentRailOptions = {}): UsdcPaymentRailShim {
  const config = readUsdcEnvConfig();
  const chainClient = options.chainClient ?? realChainClient(config.rpcUrl, config.tokenContract);
  const rateSource = options.rateSource ?? defaultRateSource;
  const halfPaidStorage = options.halfPaidStorage ?? createPrismaUsdcHalfPaidStorage();

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
      return {
        rail: 'usdc',
        jobId: input.jobId,
        leg: input.leg,
        chainId: config.chainId,
        tokenContract: config.tokenContract,
        operatorAddress: input.operatorAddress,
        feeAddress: config.feeAddress,
        priceTxHash: input.priceTxHash,
        feeTxHash: input.feeTx.signed ? input.feeTx.hash : null,
      };
    },

    async confirm(ref: UsdcPaymentRef): Promise<Confirmation> {
      // Idempotent by construction: every call re-reads both receipts from
      // the chain and answers from what it observes, never from a cached
      // verdict, so two calls on the same ref cannot disagree with
      // themselves (the interface's own idempotency requirement).
      const price = await legStatus(chainClient, ref.priceTxHash);
      // A null feeTxHash means the wallet never signed the fee transfer at
      // all: not_signed, never a receipt lookup invented for a hash that
      // does not exist (P3 brief, "never report a leg it did not see a
      // receipt for").
      const fee: UsdcLegStatus = ref.feeTxHash === null ? { status: 'not_signed' } : await legStatus(chainClient, ref.feeTxHash);

      const priceConfirmed = price.status === 'confirmed';
      const feeConfirmed = fee.status === 'confirmed';
      const confirmed = priceConfirmed && feeConfirmed;
      // Half-paid: exactly one leg confirmed and the other did not, in
      // either direction (P3 brief, "the inverse case matters too: fee
      // lands, price does not. Same treatment.").
      const halfPaid = priceConfirmed !== feeConfirmed;

      if (halfPaid) {
        await halfPaidStorage.record({
          jobId: ref.jobId,
          leg: ref.leg,
          priceTxHash: ref.priceTxHash,
          priceStatus: price.status,
          feeTxHash: ref.feeTxHash,
          feeStatus: fee.status,
        });
      } else {
        // A settlement that is no longer half-paid must not leave a stale
        // half-paid row behind (P3 review round 1, D2): a late-landing
        // second signature is the ordinary case on a two-transaction rail,
        // and every confirm() call re-evaluates the current chain state
        // regardless of what a prior call wrote, matching this rail's own
        // idempotency stance. clear() is a no-op when there is no row to
        // remove, so this costs nothing on the far more common path where
        // the settlement was never half-paid to begin with.
        await halfPaidStorage.clear(ref.jobId, ref.leg);
      }

      return {
        rail: 'usdc',
        hash: ref.priceTxHash,
        confirmed,
        legs: { price, fee },
        halfPaid,
      };
    },
  };
}

// Reads one transfer's confirmation status by hash, never inventing a
// status for a receipt it did not see (P3 brief, "never report a leg it
// did not see a receipt for"). A null receipt means the transaction has
// not landed yet: not_confirmed, not a thrown error, since a pending
// transaction is an ordinary and expected state to observe. A receipt
// with status 0 (a reverted transaction) is likewise not_confirmed, never
// confirmed: only status 1 counts as landed.
async function legStatus(chainClient: UsdcChainClient, hash: string): Promise<UsdcLegStatus> {
  const receipt = await chainClient.getTransactionReceipt(hash);
  if (receipt !== null && receipt.status === 1) {
    return { status: 'confirmed', hash };
  }
  return { status: 'not_confirmed', hash };
}
