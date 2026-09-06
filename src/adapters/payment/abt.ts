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

// The three chain calls this rail makes, isolated behind an interface so
// tests never construct a real @ocap/client (no network in the test suite;
// FACTORY_RULES.md and this card both require that). The production
// default wraps the real @ocap/client Client.
export interface AbtChainClient {
  decodeTx(bytes: Uint8Array): Promise<unknown>;
  sendTx(input: { readonly tx: string; readonly commit: boolean }): Promise<{ readonly hash: string }>;
  getTx(input: { readonly hash: string }): Promise<{ readonly code: string }>;
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
    getTx: (input) => client.getTx(input),
    getAccountState: (input) => client.getAccountState(input),
  };
}

// No reliable ABT/USD feed was found at build time (see header comment).
// Fails honestly rather than guessing a number.
async function defaultRateSource(): Promise<string | null> {
  return null;
}

export interface CreateAbtPaymentRailOptions {
  readonly chainClient?: AbtChainClient;
  readonly rateSource?: RateSource;
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

export function createAbtPaymentRail(options: CreateAbtPaymentRailOptions = {}): PaymentRail {
  const config = readAbtEnvConfig();
  const platformWallet = fromSecretKey(config.platformSk);
  const chainClient = options.chainClient ?? realChainClient(config.chainHost);
  const rateSource = options.rateSource ?? defaultRateSource;

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

    async createRequest(input: CreateRequestInput): Promise<PaymentRequest> {
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

    async onWalletResponse(input: WalletResponseInput): Promise<PaymentRef> {
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
      // Carry the two output addresses forward on the ref so confirm() can
      // read exactly those two balances later without re-decoding the tx
      // (D4, review round 1). The operator address is read back from the
      // broadcast tx's own outputs (the other output, not the fee address)
      // rather than trusted from the caller, since the finalTx the wallet
      // returned is what actually got broadcast.
      const operatorOutput = decoded.itx.outputs.find((output) => output.owner !== config.feeAddress);
      return {
        rail: 'abt',
        hash: result.hash,
        operatorAddress: operatorOutput?.owner ?? '',
        feeAddress: config.feeAddress,
      };
    },

    async confirm(ref: PaymentRef): Promise<Confirmation> {
      const result = await chainClient.getTx({ hash: ref.hash });
      const confirmed = result.code === 'OK';
      if (!confirmed) {
        return { rail: 'abt', hash: ref.hash, confirmed };
      }
      const [operatorState, feeState] = await Promise.all([
        chainClient.getAccountState({ address: ref.operatorAddress }),
        chainClient.getAccountState({ address: ref.feeAddress }),
      ]);
      return {
        rail: 'abt',
        hash: ref.hash,
        confirmed,
        operatorBalance: tokenBalance(operatorState, config.token),
        feeBalance: tokenBalance(feeState, config.token),
      };
    },
  };
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
