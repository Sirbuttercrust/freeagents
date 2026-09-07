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
const OTHER_TOKEN = 'z1OtherToken000000000000000000000000000';
const platformWallet = fromRandom();
const operatorAddress = 'z1Operator0000000000000000000000000000';
const feeAddress = 'z1FeeAddress00000000000000000000000000';
const strangerAddress = 'z1Stranger0000000000000000000000000000';

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
      return overrides.getTx ? overrides.getTx(input) : { code: 'OK', outputs: [] };
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
    const rail2 = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, rateSource: async () => '1' }));

    const ref = await rail2.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx, amountUsd: '2.00' });

    expect(ref.rail).toBe('abt');
    expect(ref.hash).toBe('fakehash');
    expect(ref.operatorAddress).toBe(operatorAddress);
    expect(ref.feeAddress).toBe(feeAddress);
    expect(ref.jobId).toBe('job_1');
    expect(ref.leg).toBe('deposit');
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

  // S2: the expected operator/fee amounts are computed ONCE here, from the
  // amountUsd the caller supplied (the route reads this from the job's
  // agreed price, never from a body field -- see abt-did-connect.ts), the
  // exact same quote math createRequest already used (usdToTokenAmount +
  // fromTokenToUnit at the injected rate). confirm() has nothing else to
  // compare the chain's observed outputs against.
  it('computes expectedOperatorUnit and expectedFeeUnit from amountUsd, at the injected rate and the domain fee rate', async () => {
    const { client } = fakeChainClient();
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, rateSource: async () => '1' }));
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '100',
      feeToken: '3',
    });
    const { base58: finalTx } = await walletSignedFinalTxBase58(request.claim);

    const ref = await rail.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx, amountUsd: '100.00' });

    // At a 1:1 rate, 100.00 USD is 100 ABT; the 3 percent ABT fee on top
    // is 3 ABT. fromTokenToUnit's default is 18 decimals.
    expect(ref.expectedOperatorUnit).toBe(fromTokenToUnit('100').toString());
    expect(ref.expectedFeeUnit).toBe(fromTokenToUnit('3').toString());
  });

  // MUTATION PROOF target (the brief's "a test proves a caller-supplied
  // amount cannot override"): a caller cannot make onWalletResponse derive
  // a smaller expected amount than the job actually agreed by passing a
  // different amountUsd than what the route would have supplied -- there
  // is no path here that reads an amount from anywhere but this single
  // argument, so this test pins that the argument IS what governs the
  // computed expectation, closing the gap that a route-level trust of a
  // body field would otherwise open.
  it('a different amountUsd produces a correspondingly different expected amount (nothing else feeds the computation)', async () => {
    const { client } = fakeChainClient();
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, rateSource: async () => '1' }));
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '100',
      feeToken: '3',
    });
    const { base58: finalTx } = await walletSignedFinalTxBase58(request.claim);

    const cheapRef = await rail.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx, amountUsd: '1.00' });
    expect(cheapRef.expectedOperatorUnit).toBe(fromTokenToUnit('1').toString());
    expect(cheapRef.expectedOperatorUnit).not.toBe(fromTokenToUnit('100').toString());
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
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, rateSource: async () => '1' }));

    await rail.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx, amountUsd: '2.00' });

    expect(broadcastTxBase64).toBeDefined();
    const { fromBase64: fromB64 } = await import('@ocap/util');
    const broadcastTx = cborDecodeTx(fromB64(broadcastTxBase64 as string)) as { signature: Uint8Array };
    const unsigned = { ...cborDecodeTx(fromB64(broadcastTxBase64 as string)), signature: new Uint8Array(0) };
    const unsignedBytes = encodeTx(unsigned as never);
    const verifies = await platformWallet.verify(bytesToHex(unsignedBytes), broadcastTx.signature);
    expect(verifies).toBe(true);
  });
});

// S2: a ref carrying the two expected amounts (in the chain's smallest
// unit) and the two output addresses, matching what onWalletResponse
// would have built from amountUsd '100.00' at a 1:1 rate: 100 ABT to the
// operator, 3 ABT (the 3 percent fee) to the platform.
function refFor(hash: string): {
  readonly rail: 'abt';
  readonly hash: string;
  readonly operatorAddress: string;
  readonly feeAddress: string;
  readonly jobId: string;
  readonly leg: 'deposit' | 'balance';
  readonly expectedOperatorUnit: string;
  readonly expectedFeeUnit: string;
} {
  return {
    rail: 'abt',
    hash,
    operatorAddress,
    feeAddress,
    jobId: 'job_1',
    leg: 'deposit',
    expectedOperatorUnit: fromTokenToUnit('100').toString(),
    expectedFeeUnit: fromTokenToUnit('3').toString(),
  };
}

// The chain's own record of a transaction that paid exactly what refFor
// expects: two outputs, operator and fee, in the configured token.
function okGetTxOutputs(overrides: {
  readonly operatorOwner?: string;
  readonly operatorValue?: string;
  readonly operatorToken?: string;
  readonly feeOwner?: string;
  readonly feeValue?: string;
  readonly feeToken?: string;
} = {}) {
  return {
    code: 'OK',
    outputs: [
      {
        owner: overrides.operatorOwner ?? operatorAddress,
        tokens: [{ address: overrides.operatorToken ?? TOKEN, value: overrides.operatorValue ?? fromTokenToUnit('100').toString() }],
      },
      {
        owner: overrides.feeOwner ?? feeAddress,
        tokens: [{ address: overrides.feeToken ?? TOKEN, value: overrides.feeValue ?? fromTokenToUnit('3').toString() }],
      },
    ],
  };
}

// S2: a stateful fake of the spent-transfer storage, so a route test never
// touches Prisma and a re-confirm within one test still sees what an
// earlier record() wrote, mirroring the identical USDC fake
// (tests/api/job-payment-usdc.test.ts's fakeSpentTransferStorage).
function fakeAbtSpentTransferStorage(): {
  storage: { record: (row: { hash: string; jobId: string; leg: 'deposit' | 'balance' }) => Promise<void>; findByHash: (hash: string) => Promise<{ hash: string; jobId: string; leg: 'deposit' | 'balance' } | null> };
  rows: Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>;
} {
  const rows = new Map<string, { hash: string; jobId: string; leg: 'deposit' | 'balance' }>();
  return {
    rows,
    storage: {
      async record(row) {
        rows.set(row.hash, { ...row });
      },
      async findByHash(hash) {
        return rows.get(hash) ?? null;
      },
    },
  };
}

describe('createAbtPaymentRail: confirm (S2, binds the chain\'s own record to what this leg expects)', () => {
  // The positive control (brief, "the first thing to prove"): a binding
  // that confirms nothing is not a fix.
  it('confirms when the chain\'s own outputs pay the operator and the fee address the expected amounts, in the configured token', async () => {
    const { storage } = fakeAbtSpentTransferStorage();
    const { client } = fakeChainClient({ getTx: async () => okGetTxOutputs() });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, spentTransferStorage: storage }));

    const confirmation = await rail.confirm(refFor('abc123'));

    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.status).toBe('confirmed');
  });

  it('reports not_confirmed when the chain answers any other code', async () => {
    const { client } = fakeChainClient({ getTx: async () => ({ code: 'PENDING', outputs: [] }) });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.status).toBe('not_confirmed');
  });

  // MUTATION PROOF 1: restoring `confirmed = result.code === 'OK'` as the
  // whole check makes this go red, because code OK alone says nothing
  // about who was paid.
  it('a transaction that paid the wrong recipient answers mismatched, not confirmed, even though code is OK', async () => {
    const { client } = fakeChainClient({ getTx: async () => okGetTxOutputs({ operatorOwner: strangerAddress }) });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.status).toBe('mismatched');
  });

  // MUTATION PROOF 2: dropping the amount comparison makes this go red.
  it('a transaction that paid the right recipient the wrong amount answers mismatched', async () => {
    const { client } = fakeChainClient({
      getTx: async () => okGetTxOutputs({ operatorValue: fromTokenToUnit('1').toString() }),
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.status).toBe('mismatched');
  });

  it('a transaction carrying a different token answers mismatched', async () => {
    const { client } = fakeChainClient({
      getTx: async () => okGetTxOutputs({ operatorToken: OTHER_TOKEN }),
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.status).toBe('mismatched');
  });

  it('a transaction that paid the fee address the wrong amount also answers mismatched', async () => {
    const { client } = fakeChainClient({
      getTx: async () => okGetTxOutputs({ feeValue: fromTokenToUnit('0.5').toString() }),
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.status).toBe('mismatched');
  });

  // MUTATION PROOF 4: reading the outputs from `ref` instead of `getTx`
  // makes this go red, because a ref built with the CORRECT addresses
  // would still confirm even though the chain's own outputs (returned by
  // this fake) name a stranger. This is the load-bearing distinction the
  // brief names: "do not confirm against ref fields that came from the
  // same wallet response being checked".
  it('binds to the outputs getTx actually returns, not to the ref\'s own operatorAddress/feeAddress fields', async () => {
    const { client } = fakeChainClient({
      getTx: async () => okGetTxOutputs({ operatorOwner: strangerAddress, feeOwner: strangerAddress }),
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    // The ref itself still names the correct operatorAddress/feeAddress;
    // only the chain's OWN record (getTx) disagrees. If confirm() ever
    // trusted ref over getTx, this would wrongly confirm.
    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.status).toBe('mismatched');
  });

  // MUTATION PROOF 3: dropping the spent-hash check makes this go red.
  it('a hash that already backed one job\'s leg cannot confirm a second job', async () => {
    const { storage, rows } = fakeAbtSpentTransferStorage();
    rows.set('abc123', { hash: 'abc123', jobId: 'job_OTHER', leg: 'deposit' });
    const { client } = fakeChainClient({ getTx: async () => okGetTxOutputs() });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, spentTransferStorage: storage }));

    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.status).toBe('mismatched');
  });

  it('a hash that already backed one leg cannot confirm the other leg of the same job', async () => {
    const { storage, rows } = fakeAbtSpentTransferStorage();
    rows.set('abc123', { hash: 'abc123', jobId: 'job_1', leg: 'balance' });
    const { client } = fakeChainClient({ getTx: async () => okGetTxOutputs() });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, spentTransferStorage: storage }));

    // refFor names leg: 'deposit'; the stored row already spent this hash
    // on 'balance'.
    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.status).toBe('mismatched');
  });

  it('re-confirming the same (job, leg) is idempotent and stays confirmed', async () => {
    const { storage } = fakeAbtSpentTransferStorage();
    const { client, calls } = fakeChainClient({ getTx: async () => okGetTxOutputs() });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, spentTransferStorage: storage }));

    const ref = refFor('abc123');
    const first = await rail.confirm(ref);
    const second = await rail.confirm(ref);
    expect(first.confirmed).toBe(true);
    expect(second.confirmed).toBe(true);
    expect(calls.getTx).toHaveLength(2);
  });

  // MUTATION PROOF 5 (silent-success-on-failure): swallowing a spent-store
  // failure makes this go red, because confirm() would then answer a
  // success shape instead of propagating the failure the way the USDC
  // rail's legStatus already does (no try/catch around the storage call).
  it('a spent-store failure refuses (propagates), rather than answering confirmed', async () => {
    const failingStorage = {
      record: async () => {},
      findByHash: async () => {
        throw new Error('spent-transfer storage unavailable');
      },
    };
    const { client } = fakeChainClient({ getTx: async () => okGetTxOutputs() });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, spentTransferStorage: failingStorage }));

    await expect(rail.confirm(refFor('abc123'))).rejects.toThrow('spent-transfer storage unavailable');
  });

  // D4 (review, round 1, retained by S2): confirm reads both output
  // balances once the transaction confirms, for a caller that wants to
  // display them. types.ts's own comment on these fields is now explicit
  // that they are not evidence of anything by themselves.
  it('reads both output balances from the chain once the transaction confirms', async () => {
    const { storage } = fakeAbtSpentTransferStorage();
    const { client, calls } = fakeChainClient({
      getTx: async () => okGetTxOutputs(),
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
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, spentTransferStorage: storage }));

    const confirmation = await rail.confirm(refFor('abc123'));

    expect(confirmation.operatorBalance).toBe('2');
    expect(confirmation.feeBalance).toBe('0.06');
    expect(calls.getTx).toHaveLength(1);
  });

  it('does not read balances when the transaction is not yet confirmed', async () => {
    const { client } = fakeChainClient({
      getTx: async () => ({ code: 'PENDING', outputs: [] }),
      getAccountState: async () => {
        throw new Error('getAccountState must not be called before the transaction confirms');
      },
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.operatorBalance).toBeUndefined();
    expect(confirmation.feeBalance).toBeUndefined();
  });

  it('does not read balances when the outputs mismatch (a landed transaction that paid the wrong thing)', async () => {
    const { client } = fakeChainClient({
      getTx: async () => okGetTxOutputs({ operatorOwner: strangerAddress }),
      getAccountState: async () => {
        throw new Error('getAccountState must not be called on a mismatched transaction');
      },
    });
    const rail = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client }));

    const confirmation = await rail.confirm(refFor('abc123'));
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.operatorBalance).toBeUndefined();
    expect(confirmation.feeBalance).toBeUndefined();
  });
});
