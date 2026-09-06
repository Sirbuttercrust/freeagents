// P2: the ABT payment rail (MISSION.md invariant 12). Driven against a fake
// chain client and a fake rate source; no test in this file ever reaches the
// beta chain (that happens once, live, outside `npm test`, per the card).
//
// The reference this rail is built to: qr-server.mjs (hash
// F3209229A6E6FED27463F2A908C1C94C49E622FE55CA74A160C1C6871AFE55FA on the
// ABT beta chain, 2026-09-05). partialTx.from/pk name the platform wallet
// (the envelope sender); itx.inputs is always empty (the wallet adds the
// buyer's input); itx.outputs pay the operator and the platform fee.
import { describe, expect, it } from 'vitest';
import { fromRandom } from '@ocap/wallet';
import { fromTokenToUnit, bytesToHex } from '@ocap/util';
import { encodeTx, decodeTx as cborDecodeTx } from '@ocap/message/cbor';
import { createAbtPaymentRail } from '../../../src/adapters/payment/abt.js';
import { PaymentConfigError, RateUnavailableError } from '../../../src/adapters/payment/types.js';
import type { AbtChainClient } from '../../../src/adapters/payment/abt.js';

const TOKEN = 'z1Token00000000000000000000000000000000';
const platformWallet = fromRandom();
const operatorAddress = 'z1Operator0000000000000000000000000000';
const feeAddress = 'z1FeeAddress00000000000000000000000000';

function envConfig(): Record<string, string> {
  return {
    FREEAGENTS_ABT_CHAIN_HOST: 'https://beta.abtnetwork.io/api',
    FREEAGENTS_ABT_PLATFORM_SK: platformWallet.secretKey,
    FREEAGENTS_ABT_TOKEN: TOKEN,
    FREEAGENTS_ABT_FEE_ADDRESS: feeAddress,
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

const ALL_ABT_ENV_KEYS = [
  'FREEAGENTS_ABT_CHAIN_HOST',
  'FREEAGENTS_ABT_PLATFORM_SK',
  'FREEAGENTS_ABT_TOKEN',
  'FREEAGENTS_ABT_FEE_ADDRESS',
];

describe('createAbtPaymentRail: fails closed on missing env', () => {
  it.each(ALL_ABT_ENV_KEYS)('rejects at construction when %s is absent', (missingKey) => {
    const config = envConfig();
    delete config[missingKey];
    withEnv({ ...Object.fromEntries(ALL_ABT_ENV_KEYS.map((k) => [k, undefined])), ...config }, () => {
      expect(() => createAbtPaymentRail()).toThrow(PaymentConfigError);
    });
  });

  it('an explicit empty-string env var also fails closed (Blocklet Server materialises unset vars as \'\')', () => {
    withEnv({ ...envConfig(), FREEAGENTS_ABT_TOKEN: '' }, () => {
      expect(() => createAbtPaymentRail()).toThrow(PaymentConfigError);
    });
  });

  it('constructs successfully once every env var is present', () => {
    withEnv(envConfig(), () => {
      expect(() => createAbtPaymentRail()).not.toThrow();
    });
  });
});

describe('createAbtPaymentRail: quote (injected rate source, no network)', () => {
  it('converts priceUsd to ABT at the injected rate and computes the 3 percent fee on top', async () => {
    const rail = withEnv(envConfig(), () =>
      createAbtPaymentRail({ rateSource: async () => '1.00' }),
    );
    const quote = await rail.quote({ priceUsd: '500.00' });
    expect(quote.rail).toBe('abt');
    expect(quote.amountToken).toBe('500');
    expect(quote.feeToken).toBe('15');
    expect(quote.rateSource.length).toBeGreaterThan(0);
  });

  it('rejects with RateUnavailableError when the rate source answers null, rather than quoting a stale number', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ rateSource: async () => null }));
    await expect(rail.quote({ priceUsd: '500.00' })).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('createAbtPaymentRail: createRequest (the prepareTx claim shape)', () => {
  it('builds a partial TransferV3Tx: from/pk are the platform wallet, inputs empty, two outputs', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail());
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '2',
      feeToken: '0.06',
    });

    expect(request.rail).toBe('abt');
    expect(request.jobId).toBe('job_1');
    expect(request.leg).toBe('deposit');
    expect(request.claim.type).toBe('TransferV3Tx');
    expect(request.claim.partialTx.from).toBe(platformWallet.toAddress());
    expect(request.claim.partialTx.pk).toBe(platformWallet.publicKey);
    expect(request.claim.partialTx.itx.inputs).toEqual([]);
    expect(request.claim.partialTx.itx.outputs).toEqual([
      { owner: operatorAddress, tokens: [{ address: TOKEN, value: fromTokenToUnit(2).toString() }], assets: [] },
      { owner: feeAddress, tokens: [{ address: TOKEN, value: fromTokenToUnit(0.06).toString() }], assets: [] },
    ]);
    expect(request.claim.requirement.tokens).toEqual([
      { address: TOKEN, value: fromTokenToUnit(2.06).toString() },
    ]);
  });

  // D1 (review, round 1): createRequest used to route amountToken/feeToken
  // back through Number(), undoing the BigInt discipline src/domain/payment.ts
  // exists to guarantee. A float add (Number('0.1') + Number('0.2')) can
  // make the requirement total EXCEED the sum of its own two outputs, which
  // means the wallet is asked to satisfy a requirement the two outputs
  // named in the same claim cannot actually cover.
  it('the requirement total exactly equals the sum of the two output values, at a float-unsafe split', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail());
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '0.1',
      feeToken: '0.2',
    });
    const outputs = request.claim.partialTx.itx.outputs;
    const outputSum = outputs.reduce((sum, output) => sum + BigInt(output.tokens[0].value), 0n);
    const requirementTotal = BigInt(request.claim.requirement.tokens[0].value);
    expect(requirementTotal).toBe(outputSum);
  });

  // D1 (review, round 1): a valid 8-decimal-place token amount (exactly what
  // usdToTokenAmount's RATE_PRECISION produces) used to make Number() emit
  // scientific notation ("1e-8"), which @ocap/util's BN parser rejects with
  // an untyped "Invalid character" error rather than the typed failure this
  // card's scope requires.
  it('accepts an 8-decimal-place token amount without throwing an untyped vendor error', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail());
    await expect(
      rail.createRequest({
        jobId: 'job_1',
        leg: 'deposit',
        operatorAddress,
        amountToken: '0.00000001',
        feeToken: '0.06',
      }),
    ).resolves.toBeDefined();
  });

  // MUTATION PROOF (the brief's trap #2): dropping the explicit `pk` lets
  // the library stamp the CONNECTING USER's key onto the partial tx, and
  // the chain rejects with "Sender or delegator address does not match pk".
  // Pinning `pk` here means a regression that omits it goes red before it
  // ever reaches the beta chain.
  it('the pk field is always present and equals the platform wallet public key (never omitted)', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail());
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '2',
      feeToken: '0.06',
    });
    expect(request.claim.partialTx.pk).toBeDefined();
    expect(request.claim.partialTx.pk).not.toBe('');
    expect(request.claim.partialTx.pk).toBe(platformWallet.publicKey);
  });
});

// A scripted fake of the three chain calls onWalletResponse and confirm
// make: decodeTx, sendTx, getTx. Each records what it was asked to do.
function fakeChainClient(overrides: Partial<AbtChainClient> = {}): {
  client: AbtChainClient;
  calls: { decodeTx: unknown[]; sendTx: unknown[]; getTx: unknown[] };
} {
  const calls = { decodeTx: [] as unknown[], sendTx: [] as unknown[], getTx: [] as unknown[] };
  const client: AbtChainClient = {
    decodeTx: async (bytes) => {
      calls.decodeTx.push(bytes);
      return overrides.decodeTx ? overrides.decodeTx(bytes) : cborDecodeTx(bytes);
    },
    sendTx: async (input) => {
      calls.sendTx.push(input);
      return overrides.sendTx ? overrides.sendTx(input) : { hash: 'fakehash' };
    },
    getTx: async (input) => {
      calls.getTx.push(input);
      return overrides.getTx ? overrides.getTx(input) : { code: 'OK' };
    },
    getAccountState: async (input) =>
      overrides.getAccountState ? overrides.getAccountState(input) : { state: null },
  };
  return { client, calls };
}

// Builds a finalTx the way the WALLET would: takes the partial tx from a
// createRequest() claim, adds a buyer input, and returns it base58-encoded
// -- exactly what the DID Connect claim answer's `finalTx` field carries in
// the working reference (qr-server.mjs: `client.decodeTx(fromBase58(c.finalTx))`).
async function walletSignedFinalTxBase58(claim: {
  readonly partialTx: { readonly from: string; readonly pk: string; readonly itx: { readonly outputs: unknown } };
}): Promise<{ base58: string; buyerAddress: string }> {
  const { toBase58 } = await import('@ocap/util');
  const buyer = fromRandom();
  const decoded = {
    from: claim.partialTx.from,
    pk: claim.partialTx.pk,
    itx: {
      type: 'TransferV3Tx',
      value: {
        inputs: [{ owner: buyer.toAddress() }],
        outputs: claim.partialTx.itx.outputs,
      },
    },
    signatures: [{ signer: buyer.toAddress() }],
  };
  const bytes = encodeTx(decoded as never);
  return { base58: toBase58(bytes), buyerAddress: buyer.toAddress() };
}

describe('createAbtPaymentRail: onWalletResponse (decode, sign the envelope, broadcast)', () => {
  it('decodes the finalTx, signs the envelope with the platform wallet, and broadcasts with commit: true', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail());
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '2',
      feeToken: '0.06',
    });
    const { base58: finalTx } = await walletSignedFinalTxBase58(request.claim);
    const { client, calls } = fakeChainClient();
    const rail2 = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const ref = await rail2.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx });

    expect(ref).toEqual({ rail: 'abt', hash: 'fakehash', operatorAddress, feeAddress });
    expect(calls.decodeTx).toHaveLength(1);
    expect(calls.sendTx).toHaveLength(1);
    const sent = calls.sendTx[0] as { tx: string; commit: boolean };
    expect(sent.commit).toBe(true);
    // The broadcast envelope is signed by the platform wallet, not the
    // buyer: decode what was actually sent and check its signature is
    // non-empty and the tx still names the platform as `from`.
    const { fromBase64 } = await import('@ocap/util');
    const sentTx = cborDecodeTx(fromBase64(sent.tx)) as { from: string; signature: Uint8Array };
    expect(sentTx.from).toBe(platformWallet.toAddress());
    expect(sentTx.signature.length).toBeGreaterThan(0);
  });

  // Proves the envelope is actually signed correctly and reproducibly: the
  // broadcast signature verifies against the exact unsigned envelope bytes
  // this rail would have built (from/pk/itx/signatures unchanged, signature
  // slot empty), reconstructed independently here rather than trusted from
  // the adapter's own internals. @ocap/wallet's sign()/verify() accept
  // either a hex string or the equivalent raw bytes and treat them
  // identically (confirmed empirically), so this is the one assertion that
  // actually distinguishes "signed the right bytes" from "signed something".
  it('the broadcast envelope signature verifies against the exact unsigned envelope bytes', async () => {
    const request = await withEnv(envConfig(), () =>
      createAbtPaymentRail().createRequest({
        jobId: 'job_1',
        leg: 'deposit',
        operatorAddress,
        amountToken: '2',
        feeToken: '0.06',
      }),
    );
    const { base58: finalTx } = await walletSignedFinalTxBase58(request.claim);
    let broadcastTxBase64: string | undefined;
    const { client } = fakeChainClient({
      sendTx: async (input) => {
        broadcastTxBase64 = (input as { tx: string }).tx;
        return { hash: 'fakehash2' };
      },
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    await rail.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx });

    expect(broadcastTxBase64).toBeDefined();
    const { fromBase64: fromB64 } = await import('@ocap/util');
    const broadcastTx = cborDecodeTx(fromB64(broadcastTxBase64 as string)) as { signature: Uint8Array };
    const unsigned = { ...cborDecodeTx(fromB64(broadcastTxBase64 as string)), signature: new Uint8Array(0) };
    const unsignedBytes = encodeTx(unsigned as never);
    const verifies = await platformWallet.verify(bytesToHex(unsignedBytes), broadcastTx.signature);
    expect(verifies).toBe(true);
  });
});

describe('createAbtPaymentRail: confirm (idempotent, by hash)', () => {
  it('reads the transaction status and reports confirmed when the chain answers code OK', async () => {
    const { client } = fakeChainClient({ getTx: async () => ({ code: 'OK' }) });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm({
      rail: 'abt',
      hash: 'abc123',
      operatorAddress,
      feeAddress,
    });
    expect(confirmation.rail).toBe('abt');
    expect(confirmation.hash).toBe('abc123');
    expect(confirmation.confirmed).toBe(true);
  });

  it('reports not confirmed when the chain answers any other code', async () => {
    const { client } = fakeChainClient({ getTx: async () => ({ code: 'PENDING' }) });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm({
      rail: 'abt',
      hash: 'abc123',
      operatorAddress,
      feeAddress,
    });
    expect(confirmation.confirmed).toBe(false);
  });

  it('confirming the same hash twice asks the chain twice and answers identically both times (idempotent)', async () => {
    const { client, calls } = fakeChainClient({ getTx: async () => ({ code: 'OK' }) });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const ref = { rail: 'abt' as const, hash: 'abc123', operatorAddress, feeAddress };
    const first = await rail.confirm(ref);
    const second = await rail.confirm(ref);
    expect(first).toEqual(second);
    expect(calls.getTx).toHaveLength(2);
  });

  // D4 (review, round 1): confirm() previously checked only getTx's code.
  // The card defines confirm as "getTx code OK AND reading the two output
  // balances", and this is the one place a caller can actually see that a
  // payment landed where it was supposed to.
  it('reads both output balances from the chain once the transaction confirms', async () => {
    const { client, calls } = fakeChainClient({
      getTx: async () => ({ code: 'OK' }),
      getAccountState: async (input) => {
        if (input.address === operatorAddress) {
          return { state: { tokens: [{ address: TOKEN, value: fromTokenToUnit(2).toString() }] } };
        }
        if (input.address === feeAddress) {
          return { state: { tokens: [{ address: TOKEN, value: fromTokenToUnit(0.06).toString() }] } };
        }
        return { state: null };
      },
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm({
      rail: 'abt',
      hash: 'abc123',
      operatorAddress,
      feeAddress,
    });

    expect(confirmation.operatorBalance).toBe('2');
    expect(confirmation.feeBalance).toBe('0.06');
    expect(calls.getTx).toHaveLength(1);
  });

  it('does not read balances when the transaction is not yet confirmed', async () => {
    const { client } = fakeChainClient({
      getTx: async () => ({ code: 'PENDING' }),
      getAccountState: async () => {
        throw new Error('getAccountState must not be called before the transaction confirms');
      },
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm({
      rail: 'abt',
      hash: 'abc123',
      operatorAddress,
      feeAddress,
    });
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.operatorBalance).toBeUndefined();
    expect(confirmation.feeBalance).toBeUndefined();
  });
});
