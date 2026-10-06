// When the network recorded a transfer: the production chain client's
// recordedAt, driven against a stubbed ethers provider (the seam the other
// chain-client tests use), so no test here reaches an RPC node. Every
// expected value is written out as a literal.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
  getBlock: vi.fn(),
  getNetwork: vi.fn(),
}));

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  return {
    ...actual,
    JsonRpcProvider: class {
      getTransactionReceipt = stub.getTransactionReceipt;
      getBlock = stub.getBlock;
      getNetwork = stub.getNetwork;
    },
  };
});

const { createErc20ChainClient } = await import('../../../src/adapters/payment/erc20.js');

const TOKEN = '0xB98d4C97425d9908E66E53A6fDf673ACcA0BE986';
const HASH = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const BLOCK_HASH = '0xcccc000000000000000000000000000000000000000000000000000000000003';

describe('createErc20ChainClient: recordedAt', () => {
  beforeEach(() => {
    stub.getTransactionReceipt.mockReset();
    stub.getBlock.mockReset();
    stub.getNetwork.mockReset();
  });

  it('answers the block time of the receipt, converted from seconds to a Date', async () => {
    stub.getTransactionReceipt.mockResolvedValue({ status: 1, logs: [], blockHash: BLOCK_HASH });
    stub.getBlock.mockResolvedValue({ timestamp: 1791000000 });
    const recordedAt = await createErc20ChainClient('https://rpc.example.test', TOKEN).recordedAt(HASH);
    expect(recordedAt).toEqual(new Date('2026-10-03T04:00:00.000Z'));
    expect(stub.getTransactionReceipt.mock.calls).toEqual([[HASH]]);
    expect(stub.getBlock.mock.calls).toEqual([[BLOCK_HASH]]);
  });

  it('answers null when the chain has no receipt for the hash, and reads no block', async () => {
    stub.getTransactionReceipt.mockResolvedValue(null);
    const recordedAt = await createErc20ChainClient('https://rpc.example.test', TOKEN).recordedAt(HASH);
    expect(recordedAt).toBeNull();
    expect(stub.getBlock).not.toHaveBeenCalled();
  });

  it('answers null when the receipt names a block the node cannot find', async () => {
    stub.getTransactionReceipt.mockResolvedValue({ status: 1, logs: [], blockHash: BLOCK_HASH });
    stub.getBlock.mockResolvedValue(null);
    expect(await createErc20ChainClient('https://rpc.example.test', TOKEN).recordedAt(HASH)).toBeNull();
  });

  it('lets a failing node surface instead of answering null', async () => {
    stub.getTransactionReceipt.mockResolvedValue({ status: 1, logs: [], blockHash: BLOCK_HASH });
    stub.getBlock.mockRejectedValue(new Error('rpc down'));
    await expect(createErc20ChainClient('https://rpc.example.test', TOKEN).recordedAt(HASH)).rejects.toThrow('rpc down');
  });
});
