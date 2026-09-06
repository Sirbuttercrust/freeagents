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
// verification. `getTransactionReceipt` now carries the ERC-20 Transfer
// log's own facts (recipient, value, emitting contract, chain id)
// alongside the receipt's status, and `legStatus` binds a leg's confirm
// answer to those facts matching what THIS job's price agreed to, never
// to "some transaction succeeded on this chain".
import { Contract, Interface, JsonRpcProvider } from 'ethers';
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
import { createPrismaUsdcSpentTransferStorage } from './usdc-spent-transfer-storage-prisma.js';
import type { UsdcSpentTransferStorage, UsdcTransferRole } from './usdc-spent-transfer-storage-types.js';

type UsdcPaymentRequest = Extract<PaymentRequest, { rail: 'usdc' }>;
type UsdcWalletResponseInput = Extract<WalletResponseInput, { rail: 'usdc' }>;
type UsdcPaymentRef = Extract<PaymentRef, { rail: 'usdc' }>;

// The ERC-20 Transfer event this rail reads out of a receipt's logs (S1):
// the one fact a receipt carries that a settlement check can actually bind
// to, since `status: 1` alone answers "did some transaction succeed on
// this chain" and nothing about who was paid, how much, or in what.
export interface UsdcObservedTransfer {
  readonly to: string;
  readonly value: string;
  readonly tokenContract: string;
  readonly chainId: number;
}

// S1 review round 1, D1 and D2: a transaction hash is resolved
// case-insensitively by an Ethereum node (verified live, read-only,
// against the same RPC this rail's config names: one transaction, two
// spellings, one receipt). Every hash is normalized to lower case at the
// single boundary where it first arrives from a caller -- onWalletResponse
// for the rail, the wallet-response route for the Case D refusal -- and
// never compared in its raw form again, so the spent-hash check and the
// price-equals-fee refusal cannot be walked past by respelling a hash.
export function normalizeUsdcTxHash(hash: string): string {
  return hash.toLowerCase();
}

// The one chain call this rail needs before broadcast: reading the token's
// own decimals (P3 brief, "read token decimals from the contract; do not
// hardcode 6"), isolated behind an interface so tests never construct a
// real ethers Provider (no network in the test suite; FACTORY_RULES.md and
// this card both require that). The production default wraps a real
// ethers JsonRpcProvider + Contract.
//
// S1: `transfer` is null exactly when the receipt carries no ERC-20
// Transfer log emitted by the configured token contract -- a receipt for
// something that is not a token transfer at all, which must never
// confirm regardless of `status`.
export interface UsdcChainClient {
  decimals(): Promise<number>;
  getTransactionReceipt(
    hash: string,
  ): Promise<{ readonly status: number | null; readonly transfer: UsdcObservedTransfer | null } | null>;
}

const ERC20_TRANSFER_EVENT_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

function realChainClient(rpcUrl: string, tokenContract: string): UsdcChainClient {
  const provider = new JsonRpcProvider(rpcUrl);
  const erc20Abi = ['function decimals() view returns (uint8)'];
  const contract = new Contract(tokenContract, erc20Abi, provider);
  const decimalsFn = contract.getFunction('decimals');
  const transferInterface = new Interface(ERC20_TRANSFER_EVENT_ABI);
  return {
    decimals: async () => Number(await decimalsFn()),
    getTransactionReceipt: async (hash) => {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt === null) return null;
      // S1: read the Transfer log the token contract itself emitted, not
      // any log a receipt happens to carry -- a receipt is read fresh
      // every call, and the chain id comes from the SAME provider that
      // read it, never from config, so a fork or a misconfigured RPC
      // cannot silently make a wrong-chain receipt look right.
      const network = await provider.getNetwork();
      let transfer: UsdcObservedTransfer | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== tokenContract.toLowerCase()) continue;
        let parsed;
        try {
          parsed = transferInterface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          continue;
        }
        if (parsed === null || parsed.name !== 'Transfer') continue;
        transfer = {
          to: String(parsed.args.to),
          value: (parsed.args.value as bigint).toString(),
          tokenContract: log.address,
          chainId: Number(network.chainId),
        };
        break;
      }
      return { status: receipt.status, transfer };
    },
  };
}

interface UsdcEnvConfig {
  readonly rpcUrl: string;
  readonly tokenContract: string;
  readonly chainId: number;
  readonly feeAddress: string;
}

// Shape check for FREEAGENTS_USDC_CHAIN_ID, shared with the P9 startup
// configuration report (report.ts): "configured" must mean the same thing
// in both places, so the report never claims the chain id is set when it
// is a value readUsdcEnvConfig would reject. String round-trip catches
// leading zeros, whitespace and scientific notation that Number.parseInt
// alone would silently accept.
export function isValidUsdcChainId(raw: string): boolean {
  const chainId = Number.parseInt(raw, 10);
  return Number.isInteger(chainId) && chainId > 0 && String(chainId) === raw;
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
  const chainClient = options.chainClient ?? realChainClient(config.rpcUrl, config.tokenContract);
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
      // Idempotent by construction: every call re-reads both receipts from
      // the chain and answers from what it observes, never from a cached
      // verdict, so two calls on the same ref cannot disagree with
      // themselves (the interface's own idempotency requirement).
      const price = await legStatus(chainClient, spentTransferStorage, ref.priceTxHash, {
        recipient: ref.operatorAddress,
        amountBaseUnits: ref.expectedPriceBaseUnits,
        tokenContract: ref.tokenContract,
        chainId: ref.chainId,
        jobId: ref.jobId,
        leg: ref.leg,
        role: 'price',
      });
      // A null feeTxHash means the wallet never signed the fee transfer at
      // all: not_signed, never a receipt lookup invented for a hash that
      // does not exist (P3 brief, "never report a leg it did not see a
      // receipt for").
      const fee: UsdcLegStatus =
        ref.feeTxHash === null
          ? { status: 'not_signed' }
          : await legStatus(chainClient, spentTransferStorage, ref.feeTxHash, {
              recipient: ref.feeAddress,
              amountBaseUnits: ref.expectedFeeBaseUnits,
              tokenContract: ref.tokenContract,
              chainId: ref.chainId,
              jobId: ref.jobId,
              leg: ref.leg,
              role: 'fee',
            });

      const priceConfirmed = price.status === 'confirmed';
      const feeConfirmed = fee.status === 'confirmed';
      const confirmed = priceConfirmed && feeConfirmed;
      // Half-paid: exactly one leg confirmed and the other did not, in
      // either direction (P3 brief, "the inverse case matters too: fee
      // lands, price does not. Same treatment."). A mismatched leg is
      // not a confirmed leg (S1 brief, scope item 5), so it falls on the
      // same side of this comparison as not_confirmed and not_signed.
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

interface ExpectedLegTransfer {
  readonly recipient: string;
  readonly amountBaseUnits: string;
  readonly tokenContract: string;
  readonly chainId: number;
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  readonly role: UsdcTransferRole;
}

// S1: reads one leg's confirmation status by hash, binding it to what
// THIS job's leg actually expects rather than to any confirmed hash on
// the chain (the anchor: "the question the settlement gate exists to ask
// is 'was THIS job's price paid to THIS recipient'"). A leg confirms only
// when the receipt exists, status is 1, the observed transfer's
// recipient/amount/token/chain all equal what was expected, AND the hash
// has never backed a different (job, leg, role) before. Anything else is
// not_confirmed (nothing has landed, or the receipt is unreadable as a
// token transfer at all in a way indistinguishable from not-yet-landed)
// or mismatched (something landed, on this exact hash, but it is not the
// payment this leg was expecting).
async function legStatus(
  chainClient: UsdcChainClient,
  spentTransferStorage: UsdcSpentTransferStorage,
  hash: string,
  expected: ExpectedLegTransfer,
): Promise<UsdcLegStatus> {
  // S1 review round 1, D1: normalized again here, not merely trusted from
  // the caller, so a ref built anywhere other than onWalletResponse still
  // cannot compare a raw hash against a normalized spent-transfer row.
  const normalizedHash = normalizeUsdcTxHash(hash);
  const receipt = await chainClient.getTransactionReceipt(normalizedHash);
  if (receipt === null || receipt.status !== 1) {
    return { status: 'not_confirmed', hash: normalizedHash };
  }
  const { transfer } = receipt;
  const paysWhatWasExpected =
    transfer !== null &&
    transfer.to.toLowerCase() === expected.recipient.toLowerCase() &&
    transfer.value === expected.amountBaseUnits &&
    transfer.tokenContract.toLowerCase() === expected.tokenContract.toLowerCase() &&
    transfer.chainId === expected.chainId;
  if (!paysWhatWasExpected) {
    return { status: 'mismatched', hash: normalizedHash };
  }

  // Spent-hash check (S1 scope item 4, the anchor's Case C): a receipt
  // that DOES pay what this leg expects still does not confirm if the
  // exact same hash already backs a different job, leg, or role. Re-
  // confirming the SAME (job, leg, role) is the ordinary idempotent path
  // and falls through to record() below, which upserts rather than
  // duplicating.
  const spent = await spentTransferStorage.findByHash(normalizedHash);
  if (spent !== null && (spent.jobId !== expected.jobId || spent.leg !== expected.leg || spent.role !== expected.role)) {
    return { status: 'mismatched', hash: normalizedHash };
  }
  await spentTransferStorage.record({ hash: normalizedHash, jobId: expected.jobId, leg: expected.leg, role: expected.role });
  return { status: 'confirmed', hash: normalizedHash };
}
