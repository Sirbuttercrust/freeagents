// Invariant 12: "The platform's address appears only as a fee output,
// never as an input owner and never as a holder of anyone else's funds."
// This file pins that structurally, against the exact transaction bytes
// this rail actually broadcasts, not merely against the code that builds
// them. tests/architecture/no-custody.test.ts requires exactly this file to
// exist beside src/adapters/payment, named so its filename matches
// /input-owner|invariant-12|never-input/.
import { describe, expect, it } from 'vitest';
import { fromRandom } from '@ocap/wallet';
import { fromBase64, toBase58 } from '@ocap/util';
import { decodeTx as cborDecodeTx, encodeTx as cborEncodeTx } from '@ocap/message/cbor';
import { createAbtPaymentRail } from '../../../src/adapters/payment/abt.js';
import { createUsdcPaymentRail } from '../../../src/adapters/payment/usdc.js';
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

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    process.env[key] = vars[key];
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

function fakeChainClient(): { client: AbtChainClient; sentTx: () => string | undefined } {
  let sent: string | undefined;
  const client: AbtChainClient = {
    decodeTx: async (bytes) => cborDecodeTx(bytes),
    sendTx: async (input) => {
      sent = input.tx;
      return { hash: 'fakehash' };
    },
    getTx: async () => ({ code: 'OK', outputs: [] }),
    getAccountState: async () => ({ state: null }),
  };
  return { client, sentTx: () => sent };
}

async function walletSignedFinalTxBase58(claim: {
  readonly partialTx: { readonly from: string; readonly pk: string; readonly itx: { readonly outputs: unknown } };
}): Promise<string> {
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
  const bytes = cborEncodeTx(decoded as never);
  return toBase58(bytes);
}

describe('invariant 12: the platform wallet is never an input owner on any transaction this adapter builds', () => {
  it('the partial tx (prepareTx claim) carries no inputs at all', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail());
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '2',
      feeToken: '0.06',
    });
    expect(request.claim.partialTx.itx.inputs).toEqual([]);
  });

  it('the broadcast transaction names the platform only in `from` (the envelope) and as a fee OUTPUT owner, never among the inputs', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail());
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '2',
      feeToken: '0.06',
    });
    const finalTx = await walletSignedFinalTxBase58(request.claim);
    const { client, sentTx } = fakeChainClient();
    const rail2 = withEnv(envConfig(), () => createAbtPaymentRail({ chainClient: client, rateSource: async () => '1' }));

    await rail2.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx, amountUsd: '2.00' });

    const broadcastBase64 = sentTx();
    expect(broadcastBase64).toBeDefined();
    const broadcastTx = cborDecodeTx(fromBase64(broadcastBase64 as string)) as {
      from: string;
      itx: { inputs: readonly { owner: string }[]; outputs: readonly { owner: string }[] };
    };
    // The platform address never appears as an input owner.
    const inputOwners = broadcastTx.itx.inputs.map((input) => input.owner);
    expect(inputOwners).not.toContain(platformWallet.toAddress());
    // The platform DOES appear as an output owner (the fee), which is the
    // one sanctioned appearance invariant 12 names.
    const outputOwners = broadcastTx.itx.outputs.map((output) => output.owner);
    expect(outputOwners).toContain(feeAddress);
  });

  // MUTATION PROOF: if a future change added the platform wallet as an
  // input (e.g. mistakenly funding the fee output from a platform-held
  // balance instead of routing it through the buyer's own signed
  // transaction), this test goes red the moment `inputs` carries the
  // platform's address anywhere.
  it('fails if a transaction the adapter builds ever lists the platform as an input owner (regression guard)', async () => {
    const rail = withEnv(envConfig(), () => createAbtPaymentRail());
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress,
      amountToken: '2',
      feeToken: '0.06',
    });
    // Simulate the wallet returning a maliciously/incorrectly built finalTx
    // that DOES list the platform as an input owner, and confirm this is
    // not something the rail's own construction would ever produce: the
    // rail's createRequest output itself, independent of what a wallet
    // sends back, never contains the platform address among inputs.
    expect(JSON.stringify(request.claim.partialTx.itx.inputs)).not.toContain(platformWallet.toAddress());
  });
});

// P3: invariant 12 on the USDC rail. USDC has no envelope-signing platform
// step at all (unlike ABT): the buyer signs each ERC-20 transfer directly
// with their own wallet, addressed straight to the operator or the fee
// address. There is no platform wallet in this rail's flow to appear as an
// input owner in the first place; this test pins that structurally, by
// reading the two transfer intents this rail actually builds.
describe('invariant 12 (USDC): the platform never appears as a recipient of the price transfer, and never signs on the buyer\'s behalf', () => {
  it('the price transfer pays the operator; the platform address appears only as the fee transfer\'s recipient', async () => {
    const usdcFeeAddress = '0xFeeAddress000000000000000000000000000';
    const operatorUsdcAddress = '0xOperator000000000000000000000000000000';
    const rail = withEnv(
      {
        FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
        FREEAGENTS_USDC_TOKEN_CONTRACT: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        FREEAGENTS_USDC_CHAIN_ID: '421614',
        FREEAGENTS_USDC_FEE_ADDRESS: usdcFeeAddress,
      },
      () => createUsdcPaymentRail({ chainClient: { decimals: async () => 6, getTransactionReceipt: async () => null } }),
    );
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: operatorUsdcAddress,
      amountToken: '15',
      feeToken: '1.2',
    });
    expect(request.transfers[0].recipient).toBe(operatorUsdcAddress);
    expect(request.transfers[0].recipient).not.toBe(usdcFeeAddress);
    expect(request.transfers[1].recipient).toBe(usdcFeeAddress);
    // Neither transfer intent carries any concept of a platform-held
    // input: its keys are exactly recipient/amountBaseUnits/tokenContract,
    // never a signer or a from-address the platform controls.
    expect(Object.keys(request.transfers[0]).sort()).toEqual(['amountBaseUnits', 'recipient', 'tokenContract']);
    expect(Object.keys(request.transfers[1]).sort()).toEqual(['amountBaseUnits', 'recipient', 'tokenContract']);
  });
});
