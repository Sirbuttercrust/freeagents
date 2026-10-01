// The ERC-20 settlement mechanism for a rail that pays in an ERC-20 token
// from a browser wallet. One rail calls it today, the USDC rail (usdc.ts,
// Arbitrum). Everything here is parameterised by the token contract and
// chain id the caller passes in; nothing here knows which token or which
// chain it is serving, so another ERC-20 rail can call it unchanged, and a
// comment below that says "the rail" means whichever rail called it.
//
// ERC-20 has no multi-output transfer: one payment leg is TWO separate
// `transfer` calls, price to the owner then fee to the platform. A leg
// confirms only when both transfers, read back from the chain, pay what this
// job's price agreed to. A transaction hash alone is never the verification:
// the receipt's own ERC-20 Transfer log carries the recipient, value,
// emitting contract and chain id, and `legStatus` binds the answer to those
// facts. No test reaches a real RPC; the chain client below is the seam.
import { Contract, Interface, JsonRpcProvider } from 'ethers';
import type { Confirmation, UsdcLegStatus } from './types.js';
import type { UsdcHalfPaidStorage } from './usdc-half-paid-storage-types.js';
import type { UsdcSpentTransferStorage, UsdcTransferRole } from './usdc-spent-transfer-storage-types.js';

// The ERC-20 Transfer event a rail reads out of a receipt's logs: the one
// fact a receipt carries that a settlement check can bind to, since
// `status: 1` alone answers "did some transaction succeed on this chain"
// and nothing about who was paid, how much, or in what.
export interface Erc20ObservedTransfer {
  readonly to: string;
  readonly value: string;
  readonly tokenContract: string;
  readonly chainId: number;
}

// A transaction hash is resolved case-insensitively by an Ethereum node, so
// every hash is lower-cased at the one boundary where it first arrives from
// a caller and never compared in its raw form again. That keeps the
// spent-hash check from being walked past by respelling a hash.
export function normalizeTxHash(hash: string): string {
  return hash.toLowerCase();
}

// The chain calls a rail needs, behind an interface so tests never build a
// real ethers provider. `decimals` is read from the token contract, never
// assumed. `transfer` is null exactly when the receipt carries no ERC-20
// Transfer log emitted by the configured token contract: a receipt for
// something that is not a payment in this token, which must never confirm
// whatever its `status` says.
export interface Erc20ChainClient {
  decimals(): Promise<number>;
  getTransactionReceipt(
    hash: string,
  ): Promise<{ readonly status: number | null; readonly transfer: Erc20ObservedTransfer | null } | null>;
}

const ERC20_TRANSFER_EVENT_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

// The production chain client: ethers' JsonRpcProvider and a Contract for
// `decimals()`.
export function createErc20ChainClient(rpcUrl: string, tokenContract: string): Erc20ChainClient {
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
      // Read the Transfer log the token contract itself emitted, not any
      // log a receipt happens to carry. A receipt is read fresh every call,
      // and the chain id comes from the SAME provider that read it, never
      // from config, so a fork or a misconfigured RPC cannot silently make
      // a wrong-chain receipt look right.
      const network = await provider.getNetwork();
      let transfer: Erc20ObservedTransfer | null = null;
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

// Shape check for a rail's configured chain id. The startup configuration
// report (report.ts) reaches it through usdc.ts, which re-exports it as
// isValidUsdcChainId: "configured" must mean the same thing in the rail and
// in the report, so the report never claims a chain id is set when it is a
// value the rail would reject. The string round-trip catches leading zeros,
// whitespace and scientific notation that Number.parseInt alone would
// silently accept.
export function isValidChainId(raw: string): boolean {
  const chainId = Number.parseInt(raw, 10);
  return Number.isInteger(chainId) && chainId > 0 && String(chainId) === raw;
}

export interface ExpectedLegTransfer {
  readonly recipient: string;
  readonly amountBaseUnits: string;
  readonly tokenContract: string;
  readonly chainId: number;
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  readonly role: UsdcTransferRole;
}

// Reads one transfer's confirmation status by hash, binding it to what THIS
// job's leg expects rather than to any confirmed hash on the chain: the
// question a settlement gate asks is "was THIS job's price paid to THIS
// recipient, in THIS token, on THIS chain". A transfer confirms only when
// the receipt exists, its status is 1, the observed transfer's
// recipient/amount/token/chain all equal what was expected, AND the hash has
// never backed a different (job, leg, role) before. Anything else is
// not_confirmed (nothing has landed) or mismatched (something landed on this
// exact hash, but it is not the payment this leg was expecting).
//
// The spent-hash storage passed in is the calling rail's own: a hash is only
// unique within one chain, so each rail keeps its own record of spent hashes.
export async function legStatus(
  chainClient: Erc20ChainClient,
  spentTransferStorage: UsdcSpentTransferStorage,
  hash: string,
  expected: ExpectedLegTransfer,
): Promise<UsdcLegStatus> {
  // Normalised again here, not merely trusted from the caller, so a ref
  // built anywhere other than the rail's onWalletResponse still cannot
  // compare a raw hash against a normalised spent-transfer row.
  const normalizedHash = normalizeTxHash(hash);
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

  // A receipt that DOES pay what this leg expects still does not confirm if
  // the exact same hash already backs a different job, leg, or role.
  // Re-confirming the SAME (job, leg, role) is the ordinary idempotent path
  // and falls through to record() below, which upserts rather than
  // duplicating.
  const spent = await spentTransferStorage.findByHash(normalizedHash);
  if (spent !== null && (spent.jobId !== expected.jobId || spent.leg !== expected.leg || spent.role !== expected.role)) {
    return { status: 'mismatched', hash: normalizedHash };
  }
  await spentTransferStorage.record({ hash: normalizedHash, jobId: expected.jobId, leg: expected.leg, role: expected.role });
  return { status: 'confirmed', hash: normalizedHash };
}

// What a rail's confirm() needs from its ref. The USDC rail's ref carries
// these fields under these names, and another ERC-20 rail's ref must too.
export interface Erc20LegRef {
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  readonly chainId: number;
  readonly tokenContract: string;
  readonly operatorAddress: string;
  readonly feeAddress: string;
  readonly priceTxHash: string;
  // null exactly when the wallet never signed the fee transfer: a hash is
  // never invented to look a receipt up for one that was never sent.
  readonly feeTxHash: string | null;
  readonly expectedPriceBaseUnits: string;
  readonly expectedFeeBaseUnits: string;
}

// The two-transfer confirm a rail calls with its own ref and storage.
// Idempotent by construction: every call re-reads both receipts from the
// chain and answers from what it observes, never from a cached verdict, so
// two calls on the same ref cannot disagree with themselves. The half-paid
// row (exactly one leg confirmed, in either direction) is written when the
// leg is half-paid and removed once both transfers land, since a
// late-landing second signature is the ordinary case on a two-transfer rail
// and a stale row would call a finished settlement half-paid. A mismatched
// transfer is not a confirmed one, so it falls on the same side of that
// comparison as not_confirmed and not_signed.
export async function confirmLegs(
  ref: Erc20LegRef,
  chainClient: Erc20ChainClient,
  spentTransferStorage: UsdcSpentTransferStorage,
  halfPaidStorage: UsdcHalfPaidStorage,
): Promise<Pick<Confirmation, 'hash' | 'confirmed' | 'legs' | 'halfPaid'> & { readonly legs: NonNullable<Confirmation['legs']> }> {
  const price = await legStatus(chainClient, spentTransferStorage, ref.priceTxHash, {
    recipient: ref.operatorAddress,
    amountBaseUnits: ref.expectedPriceBaseUnits,
    tokenContract: ref.tokenContract,
    chainId: ref.chainId,
    jobId: ref.jobId,
    leg: ref.leg,
    role: 'price',
  });
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
    // clear() is a no-op when there is no row, so this costs nothing on the
    // far more common path where the leg was never half-paid.
    await halfPaidStorage.clear(ref.jobId, ref.leg);
  }

  return {
    hash: ref.priceTxHash,
    confirmed: priceConfirmed && feeConfirmed,
    legs: { price, fee },
    halfPaid,
  };
}
