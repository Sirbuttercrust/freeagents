// ABT payment rail (MISSION.md invariant 12, this card). Implements the
// exact protocol shape proved by execution on 2026-09-05 against a real
// mobile DID Wallet on the ABT beta chain (hash
// F3209229A6E6FED27463F2A908C1C94C49E622FE55CA74A160C1C6871AFE55FA), taken
// unmodified from the operator's wallet-test reference script:
//
//   1. A partial TransferV3Tx: `from`/`pk` are the PLATFORM wallet (the
//      envelope sender), `itx.inputs` empty (the wallet adds the buyer's
//      input), `itx.outputs` pay the operator and the platform fee.
//   2. The wallet signs and returns `finalTx` (base58-encoded).
//   3. The platform decodes it, signs the ENVELOPE (empty signature slot,
//      hash-first: `wallet.sign(bytesToHex(encodeTx(tx)))`), and broadcasts
//      via `sendTx({ tx: toBase64(encodeTx(tx)), commit: true })`.
//   4. Confirms via `getTx({ hash })` code `OK`.
//
// Never an input owner: the platform wallet supplies the envelope signature
// only, never a signed input entry, on any transaction this file builds
// (invariant 12; pinned by tests/adapters/payment/abt-never-input-owner.test.ts).
//
// Rate source: no reliable ABT/USD spot price feed was found at build time
// (brief scope item 3 anticipates this). The production default therefore
// returns null (RateUnavailableError surfaces to the route) until a named
// feed is chosen; callers inject a RateSource for tests and may inject a
// real one once a source is picked. This is recorded, not guessed past
// (FACTORY_RULES.md 7.1: a product value, held for a human, not blocking
// the build).
import Client from '@ocap/client';
import { fromSecretKey } from '@ocap/wallet';
import { bytesToHex, fromBase58, fromTokenToUnit, fromUnitToToken, toBase64 } from '@ocap/util';
import { encodeTx as cborEncodeTx } from '@ocap/message/cbor';
import { ABT_FEE_RATE_PERCENT, calculateFee, usdToTokenAmount } from '../../domain/payment.js';
import {
  PaymentConfigError,
  RateUnavailableError,
  type Confirmation,
  type CreateRequestInput,
  type PaymentRail,
  type PaymentRef,
  type PaymentRequest,
  type PrepareTxClaim,
  type Quote,
  type RateSource,
  type WalletResponseInput,
} from './types.js';
import { createPrismaAbtSpentTransferStorage } from './abt-spent-transfer-storage-prisma.js';
import type { AbtSpentTransferStorage } from './abt-spent-transfer-storage-types.js';

// The abt-only slice of each opaque union, so a caller already holding an
// AbtPaymentRail (this file's own tests, and any other caller who received
// this rail specifically rather than through a dispatch table keyed on
// PaymentRail) gets the concrete claim/hash shape back without narrowing
// PaymentRequest itself (P3 added the `usdc` member to that union; this
// file never edits it). Structurally compatible with PaymentRail: a
// narrower return type is assignable to the wider one, so this rail still
// satisfies PaymentRail for a caller that only holds the general interface.
type AbtPaymentRequest = Extract<PaymentRequest, { rail: 'abt' }>;
type AbtWalletResponseInput = Extract<WalletResponseInput, { rail: 'abt' }>;
type AbtPaymentRef = Extract<PaymentRef, { rail: 'abt' }>;

export interface AbtPaymentRail extends Omit<PaymentRail, 'createRequest' | 'onWalletResponse' | 'confirm'> {
  readonly rail: 'abt';
  createRequest(input: CreateRequestInput): Promise<AbtPaymentRequest>;
  onWalletResponse(input: AbtWalletResponseInput): Promise<AbtPaymentRef>;
  confirm(ref: AbtPaymentRef): Promise<Confirmation>;
}

// The outputs a TransferV3Tx broadcasts, as the chain's own getTx query
// reports them (S2). Each output pays one owner some tokens; a
// TransferV3Tx built by createRequest above always carries exactly two:
// the operator's price and the platform's fee.
export interface AbtChainOutput {
  readonly owner: string;
  readonly tokens: readonly { readonly address: string; readonly value: string }[];
}

// The three chain calls this rail makes, isolated behind an interface so
// tests never construct a real @ocap/client (no network in the test suite;
// FACTORY_RULES.md and this card both require that). The production
// default wraps the real @ocap/client Client.
//
// S2: getTx is widened from `{ code }` alone to also carry `outputs`, the
// chain's OWN decoded record of what this transaction actually paid.
// Verified live, read-only, against the real endpoint this rail's config
// names (curl to https://beta.abtnetwork.io/api, GetTx query, against the
// working reference's own broadcast hash
// F3209229A6E6FED27463F2A908C1C94C49E622FE55CA74A160C1C6871AFE55FA,
// 2026-09-06): the response nests as
// `{ code, info: { tx: { itxJson: { outputs: [{ owner, tokens: [{ address, value }] }] } } } }`,
// matching the installed @ocap/client type declarations
// (node_modules/@ocap/client/lib/node.d.ts: ResponseGetTx.info is
// TransactionInfo, TransactionInfo.tx is Transaction, Transaction.itxJson
// is the decoded transaction body). realChainClient below flattens that
// nesting so the rest of this file reads `result.outputs` directly, the
// same flattening usdc.ts's realChainClient already does for a receipt's
// Transfer log.
export interface AbtChainClient {
  decodeTx(bytes: Uint8Array): Promise<unknown>;
  sendTx(input: { readonly tx: string; readonly commit: boolean }): Promise<{ readonly hash: string }>;
  getTx(input: { readonly hash: string }): Promise<{ readonly code: string; readonly outputs: readonly AbtChainOutput[] }>;
  getAccountState(input: { readonly address: string }): Promise<{
    readonly state: { readonly tokens?: readonly { readonly address: string; readonly value: string }[] } | null;
  }>;
}

function realChainClient(chainHost: string): AbtChainClient {
  const client = new Client(chainHost);
  return {
    // decodeTx is synchronous on the real client and takes a Buffer, not a
    // bare Uint8Array; wrapped in an async function so the interface's
    // Promise-returning shape holds for every implementation alike.
    decodeTx: async (bytes) => client.decodeTx(Buffer.from(bytes)),
    sendTx: (input) => client.sendTx(input),
    getTx: async (input) => {
      const result = (await client.getTx(input)) as {
        readonly code: string;
        readonly info?: { readonly tx?: { readonly itxJson?: { readonly outputs?: readonly AbtChainOutput[] } } };
      };
      // A transaction the chain has not confirmed (code other than OK)
      // may carry no info/tx/itxJson at all; outputs defaults to empty in
      // that case, which is safe because confirm() never reads outputs
      // unless code is OK.
      return { code: result.code, outputs: result.info?.tx?.itxJson?.outputs ?? [] };
    },
    getAccountState: (input) => client.getAccountState(input),
  };
}

// No reliable ABT/USD feed was found at build time (see header comment).
// Fails honestly rather than guessing a number.
async function defaultRateSource(): Promise<string | null> {
  return null;
}

// Shape check for FREEAGENTS_ABT_PLATFORM_SK, shared with the P9 startup
// configuration report (report.ts): "configured" must mean the same thing
// in both places, so the report never claims the platform key is set when
// it is a value fromSecretKey would reject. Delegates to fromSecretKey
// itself rather than duplicating its key-length rule, since that rule
// lives in @ocap/wallet, not in this file. Purely local key derivation,
// no network call, matching every other validity predicate this card adds.
export function isValidAbtPlatformSk(value: string): boolean {
  try {
    fromSecretKey(value);
    return true;
  } catch {
    return false;
  }
}

export interface CreateAbtPaymentRailOptions {
  readonly chainClient?: AbtChainClient;
  readonly rateSource?: RateSource;
  readonly spentTransferStorage?: AbtSpentTransferStorage;
}

interface AbtEnvConfig {
  readonly chainHost: string;
  readonly platformSk: string;
  readonly token: string;
  readonly feeAddress: string;
}

// Fails closed BEFORE any network call or wallet construction, the same
// posture as createGithubAdapter's requireToken (github.ts): an absent or
// empty env var throws a typed error immediately rather than proceeding
// with a half-configured rail. `||` and not destructuring straight through,
// matching every other env-derived factory in this codebase (Blocklet
// Server materialises every declared env var, so an unconfigured
// deployment delivers '' rather than undefined).
function readAbtEnvConfig(): AbtEnvConfig {
  const chainHost = process.env.FREEAGENTS_ABT_CHAIN_HOST || '';
  const platformSk = process.env.FREEAGENTS_ABT_PLATFORM_SK || '';
  const token = process.env.FREEAGENTS_ABT_TOKEN || '';
  const feeAddress = process.env.FREEAGENTS_ABT_FEE_ADDRESS || '';
  const missing = [
    ['FREEAGENTS_ABT_CHAIN_HOST', chainHost],
    ['FREEAGENTS_ABT_PLATFORM_SK', platformSk],
    ['FREEAGENTS_ABT_TOKEN', token],
    ['FREEAGENTS_ABT_FEE_ADDRESS', feeAddress],
  ]
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new PaymentConfigError(`abt payment rail: missing env var(s): ${missing.join(', ')}`);
  }
  return { chainHost, platformSk, token, feeAddress };
}

export function createAbtPaymentRail(options: CreateAbtPaymentRailOptions = {}): AbtPaymentRail {
  const config = readAbtEnvConfig();
  const platformWallet = fromSecretKey(config.platformSk);
  const chainClient = options.chainClient ?? realChainClient(config.chainHost);
  const rateSource = options.rateSource ?? defaultRateSource;
  const spentTransferStorage = options.spentTransferStorage ?? createPrismaAbtSpentTransferStorage();

  return {
    rail: 'abt',

    async quote(input: { readonly priceUsd: string }): Promise<Quote> {
      const rate = await rateSource('abt');
      if (rate === null) {
        throw new RateUnavailableError('abt');
      }
      const amountToken = usdToTokenAmount(input.priceUsd, rate);
      const feeUsd = calculateFee(input.priceUsd, ABT_FEE_RATE_PERCENT);
      const feeToken = usdToTokenAmount(feeUsd, rate);
      return {
        rail: 'abt',
        priceUsd: input.priceUsd,
        amountToken,
        feeToken,
        rateSource: `injected rate source (dollars per ABT: ${rate})`,
      };
    },

    async createRequest(input: CreateRequestInput): Promise<AbtPaymentRequest> {
      // D1 (review, round 1): fromTokenToUnit accepts a decimal STRING
      // directly and does exact big-number math internally (@ocap/util's
      // BN, not a JS float); routing the amount through Number() first
      // undid that exactness; a float add for the requirement total could
      // exceed the sum of its own two outputs, and a valid 8-decimal-place
      // amount made Number() emit scientific notation ("1e-8"), which BN's
      // parser rejects outright. Pass the strings straight through and sum
      // the two resulting BN unit amounts, never a JS number, end to end.
      const priceUnitBn = fromTokenToUnit(input.amountToken);
      const feeUnitBn = fromTokenToUnit(input.feeToken);
      const priceUnit = priceUnitBn.toString();
      const feeUnit = feeUnitBn.toString();
      const totalUnit = priceUnitBn.add(feeUnitBn).toString();
      const claim: PrepareTxClaim = {
        type: 'TransferV3Tx',
        partialTx: {
          // The platform is the envelope sender; the wallet adds the
          // buyer's input. pk is ALWAYS set explicitly (the brief's trap
          // #2): the library stamps the connecting user's pk onto the
          // partial tx when it is absent, and the chain then rejects with
          // "Sender or delegator address does not match pk".
          from: platformWallet.toAddress(),
          pk: platformWallet.publicKey,
          itx: {
            inputs: [],
            outputs: [
              { owner: input.operatorAddress, tokens: [{ address: config.token, value: priceUnit }], assets: [] },
              { owner: config.feeAddress, tokens: [{ address: config.token, value: feeUnit }], assets: [] },
            ],
          },
        },
        requirement: { tokens: [{ address: config.token, value: totalUnit }] },
        description: `Pay ${input.amountToken} to the operator plus ${input.feeToken} platform fee in one transaction`,
        display: { type: 'text', content: `FreeAgents ${input.leg}: ${input.amountToken} to operator, ${input.feeToken} fee` },
      };
      return { rail: 'abt', jobId: input.jobId, leg: input.leg, claim };
    },

    async onWalletResponse(input: AbtWalletResponseInput): Promise<AbtPaymentRef> {
      const decoded = (await chainClient.decodeTx(fromBase58(input.finalTx))) as {
        itx: { outputs: readonly { owner: string }[] };
      };
      // Sign the ENVELOPE, not an input: the platform wallet never adds an
      // input entry, only the outer transaction signature over the bytes
      // the wallet already signed as an input. Hash-first, never raw bytes
      // (the brief's trap #3): wallet.sign(hex), not wallet.sign(bytes).
      const unsigned = { ...decoded, signature: new Uint8Array(0) };
      const unsignedBytes = cborEncodeTx(unsigned as never);
      const signatureHex = await platformWallet.sign(bytesToHex(unsignedBytes));
      const signed = { ...decoded, signature: fromHexSignature(signatureHex) };
      const signedBytes = cborEncodeTx(signed as never);
      const result = await chainClient.sendTx({ tx: toBase64(signedBytes), commit: true });
      // S2 review round 2, D1: the expected operator address is the one
      // the PLATFORM named when it built this payment request
      // (input.operatorAddress, carried from the route's own
      // extraParams/CreateRequestInput -- see abt-did-connect.ts), never
      // read back out of decoded.itx.outputs. The finalTx being decoded
      // here is exactly the artifact confirm() will later check against
      // the chain's own record; deriving the expected side from that same
      // wallet-supplied artifact would let a wallet that redirects the
      // operator output also redirect what confirm() expects, so the
      // check would always agree with whatever the wallet sent.
      const rate = await rateSource('abt');
      if (rate === null) {
        throw new RateUnavailableError('abt');
      }
      const operatorAmountToken = usdToTokenAmount(input.amountUsd, rate);
      const feeUsd = calculateFee(input.amountUsd, ABT_FEE_RATE_PERCENT);
      const feeAmountToken = usdToTokenAmount(feeUsd, rate);
      return {
        rail: 'abt',
        hash: result.hash,
        operatorAddress: input.operatorAddress,
        feeAddress: config.feeAddress,
        jobId: input.jobId,
        leg: input.leg,
        expectedOperatorUnit: fromTokenToUnit(operatorAmountToken).toString(),
        expectedFeeUnit: fromTokenToUnit(feeAmountToken).toString(),
      };
    },

    async confirm(ref: AbtPaymentRef): Promise<Confirmation> {
      // S2: read THE CHAIN's own record of the transaction, never ref's
      // own operatorAddress/feeAddress/expected* fields for the observed
      // side of the comparison -- those came from the same wallet
      // response being checked, and comparing a ref against itself proves
      // only that the response agrees with itself (the anchor's load-
      // bearing distinction).
      const result = await chainClient.getTx({ hash: ref.hash });
      if (result.code !== 'OK') {
        return { rail: 'abt', hash: ref.hash, confirmed: false, status: 'not_confirmed' };
      }
      const paysWhatWasExpected =
        outputPays(result.outputs, ref.operatorAddress, ref.expectedOperatorUnit, config.token) &&
        outputPays(result.outputs, ref.feeAddress, ref.expectedFeeUnit, config.token);
      if (!paysWhatWasExpected) {
        return { rail: 'abt', hash: ref.hash, confirmed: false, status: 'mismatched' };
      }
      // Spent-hash check (brief scope item 4, the anchor's Case C): a
      // transaction that DOES pay what this leg expects still does not
      // confirm if the exact same hash already backs a different job or
      // leg. Re-confirming the SAME (job, leg) is the ordinary idempotent
      // path and falls through to record() below, which upserts rather
      // than duplicating. findByHash is awaited directly (no try/catch):
      // a storage failure propagates and refuses rather than answering a
      // success shape (silent-success-on-failure is exactly the defect
      // class this line guards against).
      const spent = await spentTransferStorage.findByHash(ref.hash);
      if (spent !== null && (spent.jobId !== ref.jobId || spent.leg !== ref.leg)) {
        return { rail: 'abt', hash: ref.hash, confirmed: false, status: 'mismatched' };
      }
      await spentTransferStorage.record({ hash: ref.hash, jobId: ref.jobId, leg: ref.leg });

      // The reported balances below are account snapshots taken AFTER the
      // binding check above already decided confirmed/status; see
      // types.ts's Confirmation comment for why they are not evidence of
      // anything by themselves.
      const [operatorState, feeState] = await Promise.all([
        chainClient.getAccountState({ address: ref.operatorAddress }),
        chainClient.getAccountState({ address: ref.feeAddress }),
      ]);
      return {
        rail: 'abt',
        hash: ref.hash,
        confirmed: true,
        status: 'confirmed',
        operatorBalance: tokenBalance(operatorState, config.token),
        feeBalance: tokenBalance(feeState, config.token),
      };
    },
  };
}

// S2: whether the chain's own outputs (from getTx, never from ref) carry
// an output paying `owner` exactly `expectedUnit` of `tokenAddress`.
// Address comparison is raw equality, not didSuffix reconciliation:
// didSuffix exists to reconcile a did:abt: DID against its bare key-hash
// form (src/domain/agent.ts), a distinction that applies to PARTY
// identities (buyers, agents, operators as DIDs). A chain address in a
// TransferV3Tx output is never a DID and is never written with a did:abt:
// prefix by this rail (createRequest builds `owner: input.operatorAddress`
// verbatim, an address string), so there is no prefix variance here to
// reconcile; raw equality is the correct comparison.
function outputPays(outputs: readonly AbtChainOutput[], owner: string, expectedUnit: string, tokenAddress: string): boolean {
  return outputs.some(
    (output) =>
      output.owner === owner && output.tokens.some((token) => token.address === tokenAddress && token.value === expectedUnit),
  );
}

// Reads a single token's balance out of a getAccountState response, in
// token units (not the raw smallest-unit string), defaulting to '0' when
// the account holds none of that token or does not yet exist on chain.
function tokenBalance(
  accountState: { readonly state: { readonly tokens?: readonly { readonly address: string; readonly value: string }[] } | null },
  tokenAddress: string,
): string {
  const token = accountState.state?.tokens?.find((entry) => entry.address === tokenAddress);
  return token === undefined ? '0' : fromUnitToToken(token.value);
}

// wallet.sign returns a hex string (see @ocap/wallet); the signature field
// on an encoded tx is bytes, so this converts once, in the one place a
// signature crosses that boundary.
function fromHexSignature(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
