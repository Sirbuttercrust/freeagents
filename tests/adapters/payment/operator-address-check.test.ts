// The one check both Ethereum-style address boxes share: the checksum first,
// then a free question to the network that box is for. An injected caller
// keeps every test off the network, and the check never throws, because an
// answer it could not get must not stop a save.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonRpcCaller } from '../../../src/adapters/payment/evm-address-lookup.js';
import { createOperatorAddressCheck } from '../../../src/adapters/payment/operator-address-check.js';

const GOOD_CHECKSUM = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const ALL_LOWER = '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d';
// One letter of the checksummed spelling flipped to the other case.
const MISTYPED = '0x75faf114eafb1bDbe2F0316DF893fd58CE46AA4d';
const ARBITRUM_URL = 'https://arbitrum.node.example.test';
const ETHEREUM_URL = 'https://ethereum.node.example.test';

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly params: readonly unknown[];
}

function recordingCaller(answer: unknown): { call: JsonRpcCaller; seen: Seen[] } {
  const seen: Seen[] = [];
  const call: JsonRpcCaller = async (url, method, params) => {
    seen.push({ url, method, params });
    return answer;
  };
  return { call, seen };
}

describe('createOperatorAddressCheck', () => {
  const saved = {
    arbitrum: process.env.FREEAGENTS_USDC_RPC_URL,
    ethereum: process.env.FREEAGENTS_ABT_ETH_RPC_URL,
  };

  beforeEach(() => {
    process.env.FREEAGENTS_USDC_RPC_URL = ARBITRUM_URL;
    process.env.FREEAGENTS_ABT_ETH_RPC_URL = ETHEREUM_URL;
  });

  afterEach(() => {
    for (const [name, value] of [
      ['FREEAGENTS_USDC_RPC_URL', saved.arbitrum],
      ['FREEAGENTS_ABT_ETH_RPC_URL', saved.ethereum],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('a failed checksum answers checksumOk false and asks no node, on either network', async () => {
    const { call, seen } = recordingCaller('0x6080');
    const check = createOperatorAddressCheck({ call });
    expect(await check.check('arbitrum', MISTYPED)).toEqual({ checksumOk: false, holdsContractCode: null });
    expect(await check.check('ethereum', MISTYPED)).toEqual({ checksumOk: false, holdsContractCode: null });
    expect(seen).toEqual([]);
  });

  it('an unset variable answers null and asks no node', async () => {
    delete process.env.FREEAGENTS_USDC_RPC_URL;
    delete process.env.FREEAGENTS_ABT_ETH_RPC_URL;
    const { call, seen } = recordingCaller('0x6080');
    const check = createOperatorAddressCheck({ call });
    expect(await check.check('arbitrum', GOOD_CHECKSUM)).toEqual({ checksumOk: true, holdsContractCode: null });
    expect(await check.check('ethereum', GOOD_CHECKSUM)).toEqual({ checksumOk: true, holdsContractCode: null });
    expect(seen).toEqual([]);
  });

  it('an empty variable answers null and asks no node', async () => {
    process.env.FREEAGENTS_USDC_RPC_URL = '';
    process.env.FREEAGENTS_ABT_ETH_RPC_URL = '';
    const { call, seen } = recordingCaller('0x6080');
    const check = createOperatorAddressCheck({ call });
    expect(await check.check('arbitrum', GOOD_CHECKSUM)).toEqual({ checksumOk: true, holdsContractCode: null });
    expect(await check.check('ethereum', GOOD_CHECKSUM)).toEqual({ checksumOk: true, holdsContractCode: null });
    expect(seen).toEqual([]);
  });

  it('a set variable asks eth_getCode at that URL for that address', async () => {
    const { call, seen } = recordingCaller('0x6080604052');
    const check = createOperatorAddressCheck({ call });
    expect(await check.check('ethereum', GOOD_CHECKSUM)).toEqual({ checksumOk: true, holdsContractCode: true });
    expect(seen).toEqual([{ url: ETHEREUM_URL, method: 'eth_getCode', params: [GOOD_CHECKSUM, 'latest'] }]);
  });

  it('Ethereum reads the Ethereum variable and Arbitrum reads the Arbitrum one', async () => {
    const { call, seen } = recordingCaller('0x');
    const check = createOperatorAddressCheck({ call });
    expect(await check.check('arbitrum', ALL_LOWER)).toEqual({ checksumOk: true, holdsContractCode: false });
    expect(await check.check('ethereum', ALL_LOWER)).toEqual({ checksumOk: true, holdsContractCode: false });
    expect(seen).toEqual([
      { url: ARBITRUM_URL, method: 'eth_getCode', params: [ALL_LOWER, 'latest'] },
      { url: ETHEREUM_URL, method: 'eth_getCode', params: [ALL_LOWER, 'latest'] },
    ]);
  });

  it('reads the variable when asked, not when the check is built', async () => {
    delete process.env.FREEAGENTS_ABT_ETH_RPC_URL;
    const { call, seen } = recordingCaller('0x');
    const check = createOperatorAddressCheck({ call });
    process.env.FREEAGENTS_ABT_ETH_RPC_URL = 'https://later.node.example.test';
    expect(await check.check('ethereum', ALL_LOWER)).toEqual({ checksumOk: true, holdsContractCode: false });
    expect(seen).toEqual([{ url: 'https://later.node.example.test', method: 'eth_getCode', params: [ALL_LOWER, 'latest'] }]);
  });

  it('a caller that throws answers null and does not throw', async () => {
    const call: JsonRpcCaller = async () => {
      throw new Error('node down');
    };
    const check = createOperatorAddressCheck({ call });
    expect(await check.check('ethereum', GOOD_CHECKSUM)).toEqual({ checksumOk: true, holdsContractCode: null });
  });

  it('a caller that never answers gives null once the timeout passes', async () => {
    const call: JsonRpcCaller = () => new Promise(() => undefined);
    const check = createOperatorAddressCheck({ call, timeoutMs: 20 });
    const started = Date.now();
    expect(await check.check('arbitrum', GOOD_CHECKSUM)).toEqual({ checksumOk: true, holdsContractCode: null });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
