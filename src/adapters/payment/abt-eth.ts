// ABT on Ethereum: the ABT token as an ERC-20 on Ethereum mainnet, paid from
// a browser wallet as two transfers (price to the owner, then the platform
// fee), the same mechanism as the USDC rail (erc20.ts holds what they
// share). Two things differ from USDC, and both come from ABT's price
// moving:
//
//   1. The ABT/USD price is CoinGecko's, read through the same feed source,
//      cache window and 5-minute staleness refusal the ArcBlock-chain rail
//      uses (abt-usd-rate.ts; each rail builds its own source instance),
//      and the platform fee is 3 percent, not USDC's 6.
//   2. The amounts the buyer is asked to sign are the amounts confirm()
//      checks. onWalletResponse takes the locked token amounts it is given
//      and converts them with the contract's decimals; it reads no rate, so
//      a price that moves between the request and the wallet's answer
//      cannot change what is expected on chain. Where the lock itself is
//      stored and how long it lives belongs to the route that starts the
//      payment; this rail only never re-quotes.
//
// No test in this file's suite reaches a network: the chain client, the
// price feed and both storage tables are injectable.
import { ABT_FEE_RATE_PERCENT, calculateFee, toBaseUnits, usdToTokenAmount } from '../../domain/payment.js';
import { createAbtUsdRateSource, type AbtUsdRateSource } from './abt-usd-rate.js';
import {
  confirmLegs,
  createErc20ChainClient,
  isValidChainId,
  normalizeTxHash,
  type AbtEthChainClient,
} from './erc20.js';
import {
  PaymentConfigError,
  RateUnavailableError,
  type Confirmation,
  type CreateRequestInput,
  type PaymentRef,
  type PaymentRequest,
  type Quote,
  type RateReading,
  type UsdcTransferIntent,
  type WalletResponseInput,
} from './types.js';
import { createPrismaAbtEthHalfPaidStorage, createPrismaAbtEthSpentTransferStorage } from './abt-eth-storage-prisma.js';
import type { UsdcHalfPaidRow, UsdcHalfPaidStorage, UsdcTransferStatus } from './usdc-half-paid-storage-types.js';
import type { UsdcSpentTransferStorage } from './usdc-spent-transfer-storage-types.js';

type AbtEthPaymentRequest = Extract<PaymentRequest, { rail: 'abt_eth' }>;
type AbtEthWalletResponseInput = Extract<WalletResponseInput, { rail: 'abt_eth' }>;
type AbtEthPaymentRef = Extract<PaymentRef, { rail: 'abt_eth' }>;

export interface AbtEthEnvConfig {
  readonly rpcUrl: string;
  readonly tokenContract: string;
  readonly chainId: number;
  readonly feeAddress: string;
}

// Fails closed BEFORE any network call: an absent or empty variable throws a
// typed error naming every missing one, rather than building a
// half-configured rail.
export function readAbtEthEnvConfig(): AbtEthEnvConfig {
  const rpcUrl = process.env.FREEAGENTS_ABT_ETH_RPC_URL || '';
  const tokenContract = process.env.FREEAGENTS_ABT_ETH_TOKEN_CONTRACT || '';
  const chainIdRaw = process.env.FREEAGENTS_ABT_ETH_CHAIN_ID || '';
  const feeAddress = process.env.FREEAGENTS_ABT_ETH_FEE_ADDRESS || '';
  const missing = [
    ['FREEAGENTS_ABT_ETH_RPC_URL', rpcUrl],
    ['FREEAGENTS_ABT_ETH_TOKEN_CONTRACT', tokenContract],
    ['FREEAGENTS_ABT_ETH_CHAIN_ID', chainIdRaw],
    ['FREEAGENTS_ABT_ETH_FEE_ADDRESS', feeAddress],
  ]
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new PaymentConfigError(`abt_eth payment rail: missing env var(s): ${missing.join(', ')}`);
  }
  if (!isValidChainId(chainIdRaw)) {
    throw new PaymentConfigError(
      `abt_eth payment rail: FREEAGENTS_ABT_ETH_CHAIN_ID must be a positive integer, got "${chainIdRaw}"`,
    );
  }
  return { rpcUrl, tokenContract, chainId: Number.parseInt(chainIdRaw, 10), feeAddress };
}

// A leg's half-paid row as the ABT-on-Ethereum rail stores it: the shared
// USDC row plus the id of the quote lock the confirmed transfer was checked
// against. lockId is optional so a store built from the USDC types still
// fits; absent reads as null, the same as a row written before the column.
export interface AbtEthHalfPaidRow extends UsdcHalfPaidRow {
  readonly lockId?: string | null;
}

export interface AbtEthHalfPaidStorage {
  record(row: AbtEthHalfPaidRow): Promise<void>;
  read(jobId: string, leg: 'deposit' | 'balance'): Promise<AbtEthHalfPaidRow | null>;
  clear(jobId: string, leg: 'deposit' | 'balance'): Promise<void>;
}

export interface CreateAbtEthPaymentRailOptions {
  // The shared client plus recordedAt: a fake without recordedAt does not
  // compile here. The USDC rail keeps the shared Erc20ChainClient.
  readonly chainClient?: AbtEthChainClient;
  // The ABT/USD feed. Defaults to the CoinGecko source the ArcBlock-chain
  // rail uses.
  readonly rateSource?: AbtUsdRateSource;
  readonly halfPaidStorage?: AbtEthHalfPaidStorage;
  readonly spentTransferStorage?: UsdcSpentTransferStorage;
}

// A Quote plus the rate it was converted at and the feed's own update time,
// so the payment session that locks the price can store and show them.
export interface AbtEthQuote extends Quote {
  readonly rail: 'abt_eth';
  readonly usdPerToken: string;
  readonly rateUpdatedAt: Date;
}

// The shape of a leg's half-paid record the start route answers with. The
// lock id is not part of what the start answers (the lock rides in
// quoteLock.id); the routes read it to finish the payment at that lock.
export interface AbtEthHalfPaidRecord {
  readonly priceTxHash: string;
  readonly priceStatus: UsdcTransferStatus;
  readonly feeTxHash: string | null;
  readonly feeStatus: UsdcTransferStatus;
}

// What readHalfPaidRecord answers: the record above plus the lock it names,
// null for a row written before the lock id was kept.
export interface AbtEthStoredHalfPaidRecord extends AbtEthHalfPaidRecord {
  readonly lockId: string | null;
}

// The shared confirmation plus the time the network recorded the price
// transfer (ISO). Read only when the price leg is confirmed; null for any
// other price leg, and null when the chain client has no block time for a
// confirmed one. judgeAbtEthLateTransfer (abt-eth-late.ts) decides from it.
export interface AbtEthConfirmation extends Confirmation {
  readonly priceRecordedAt: string | null;
}

export interface AbtEthPaymentRail {
  readonly rail: 'abt_eth';
  quote(input: { readonly priceUsd: string }): Promise<AbtEthQuote>;
  createRequest(input: CreateRequestInput): Promise<AbtEthPaymentRequest>;
  onWalletResponse(input: AbtEthWalletResponseInput): Promise<AbtEthPaymentRef>;
  confirm(ref: AbtEthPaymentRef): Promise<AbtEthConfirmation>;
  readHalfPaidRecord(jobId: string, leg: 'deposit' | 'balance'): Promise<AbtEthStoredHalfPaidRecord | null>;
}

export function createAbtEthPaymentRail(options: CreateAbtEthPaymentRailOptions = {}): AbtEthPaymentRail {
  const config = readAbtEthEnvConfig();
  const chainClient = options.chainClient ?? createErc20ChainClient(config.rpcUrl, config.tokenContract);
  const rateSource = options.rateSource ?? createAbtUsdRateSource();
  const halfPaidStorage = options.halfPaidStorage ?? createPrismaAbtEthHalfPaidStorage();
  const spentTransferStorage = options.spentTransferStorage ?? createPrismaAbtEthSpentTransferStorage();

  return {
    rail: 'abt_eth',

    async quote(input: { readonly priceUsd: string }): Promise<AbtEthQuote> {
      const reading: RateReading | null = await rateSource();
      if (reading === null) {
        throw new RateUnavailableError('abt_eth');
      }
      const amountToken = usdToTokenAmount(input.priceUsd, reading.usdPerToken);
      const feeUsd = calculateFee(input.priceUsd, ABT_FEE_RATE_PERCENT);
      const feeToken = usdToTokenAmount(feeUsd, reading.usdPerToken);
      return {
        rail: 'abt_eth',
        priceUsd: input.priceUsd,
        amountToken,
        feeToken,
        rateSource: `CoinGecko (dollars per ABT: ${reading.usdPerToken}, updated ${reading.updatedAt.toISOString()})`,
        usdPerToken: reading.usdPerToken,
        rateUpdatedAt: reading.updatedAt,
      };
    },

    async createRequest(input: CreateRequestInput): Promise<AbtEthPaymentRequest> {
      // Decimals are read off the contract on every call, never assumed: a
      // token at a different precision converts to different base units.
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
      // Price first, fee second: the wallet raises the two signatures in
      // this order.
      return {
        rail: 'abt_eth',
        jobId: input.jobId,
        leg: input.leg,
        chainId: config.chainId,
        transfers: [priceTransfer, feeTransfer],
      };
    },

    async onWalletResponse(input: AbtEthWalletResponseInput): Promise<AbtEthPaymentRef> {
      // The expected amounts are the locked token amounts converted with
      // the contract's decimals. No rate is read here: re-quoting would let
      // a price that moved after the buyer signed change what confirm()
      // accepts.
      const decimals = await chainClient.decimals();
      return {
        rail: 'abt_eth',
        jobId: input.jobId,
        leg: input.leg,
        chainId: config.chainId,
        tokenContract: config.tokenContract,
        operatorAddress: input.operatorAddress,
        feeAddress: config.feeAddress,
        // A fee hash is never invented for a transfer the wallet never signed.
        priceTxHash: normalizeTxHash(input.priceTxHash),
        feeTxHash: input.feeTx.signed ? normalizeTxHash(input.feeTx.hash) : null,
        expectedPriceBaseUnits: toBaseUnits(input.amountToken, decimals),
        expectedFeeBaseUnits: toBaseUnits(input.feeToken, decimals),
        quoteLockId: input.quoteLockId,
      };
    },

    async confirm(ref: AbtEthPaymentRef): Promise<AbtEthConfirmation> {
      // The shared two-transfer confirm (erc20.ts), against the ABT
      // contract on this rail's chain and this rail's own spent-hash and
      // half-paid tables. The half-paid row it records is written with the
      // lock the ref names, so the leg is finished at that lock; read and
      // clear pass straight through.
      const lockedHalfPaidStorage: UsdcHalfPaidStorage = {
        record: (row) => halfPaidStorage.record({ ...row, lockId: ref.quoteLockId }),
        read: (jobId, leg) => halfPaidStorage.read(jobId, leg),
        clear: (jobId, leg) => halfPaidStorage.clear(jobId, leg),
      };
      const outcome = await confirmLegs(ref, chainClient, spentTransferStorage, lockedHalfPaidStorage);
      // The block time is read only for a price transfer that confirmed: a
      // receipt that is missing or paid something else has no time that
      // means anything here.
      const recordedAt = outcome.legs.price.status === 'confirmed' ? await chainClient.recordedAt(ref.priceTxHash) : null;
      return { rail: 'abt_eth', ...outcome, priceRecordedAt: recordedAt === null ? null : recordedAt.toISOString() };
    },

    async readHalfPaidRecord(jobId: string, leg: 'deposit' | 'balance'): Promise<AbtEthStoredHalfPaidRecord | null> {
      const row = await halfPaidStorage.read(jobId, leg);
      if (row === null) return null;
      return {
        priceTxHash: row.priceTxHash,
        priceStatus: row.priceStatus,
        feeTxHash: row.feeTxHash,
        feeStatus: row.feeStatus,
        lockId: row.lockId ?? null,
      };
    },
  };
}
