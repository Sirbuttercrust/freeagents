// The contract-code lookup behind the payout-address warning. A caller is
// injected so no test reaches a network. The lookup is advice: whatever goes
// wrong, it answers null and never throws, so a save is never blocked by it.
import { describe, expect, it } from 'vitest';
import { LOOKUP_TIMEOUT_MS, checksumOk, lookupEvmAddress, type JsonRpcCaller } from '../../../src/adapters/payment/evm-address-lookup.js';

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const RPC = 'https://rpc.example.test';

describe('lookupEvmAddress', () => {
  it('answers holdsContractCode true when eth_getCode returns bytecode', async () => {
    const seen: unknown[] = [];
    const call: JsonRpcCaller = async (url, method, params) => {
      seen.push({ url, method, params });
      return '0x6080604052';
    };
    expect(await lookupEvmAddress(RPC, ADDRESS, { call })).toEqual({ holdsContractCode: true });
    expect(seen).toEqual([{ url: RPC, method: 'eth_getCode', params: [ADDRESS, 'latest'] }]);
  });

  it('answers holdsContractCode false when eth_getCode returns 0x', async () => {
    const call: JsonRpcCaller = async () => '0x';
    expect(await lookupEvmAddress(RPC, ADDRESS, { call })).toEqual({ holdsContractCode: false });
  });

  it('answers null when the node reports an error', async () => {
    const call: JsonRpcCaller = async () => {
      throw new Error('-32603 internal error');
    };
    expect(await lookupEvmAddress(RPC, ADDRESS, { call })).toEqual({ holdsContractCode: null });
  });

  it('answers null when the node returns something that is not hex code', async () => {
    const call: JsonRpcCaller = async () => ({ surprise: true });
    expect(await lookupEvmAddress(RPC, ADDRESS, { call })).toEqual({ holdsContractCode: null });
  });

  it('answers null when the node returns a string that is not hex, rather than reporting contract code', async () => {
    const call: JsonRpcCaller = async () => 'not hex';
    expect(await lookupEvmAddress(RPC, ADDRESS, { call })).toEqual({ holdsContractCode: null });
  });

  it('answers null when the node is slower than the timeout, even if it ignores the abort signal', async () => {
    const call: JsonRpcCaller = () => new Promise(() => undefined);
    const started = Date.now();
    expect(await lookupEvmAddress(RPC, ADDRESS, { call, timeoutMs: 20 })).toEqual({ holdsContractCode: null });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('waits at most 5 seconds by default', () => {
    expect(LOOKUP_TIMEOUT_MS).toBe(5000);
  });
});

describe('checksumOk', () => {
  it('runs the domain check with ethers keccak256: an EIP-55 example passes and a flipped letter fails', () => {
    expect(checksumOk('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(true);
    expect(checksumOk('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false);
  });
});
