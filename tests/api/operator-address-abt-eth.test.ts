// The owner's ABT-on-Ethereum address through PATCH /accounts/:did/operator-address,
// beside the two addresses the route already took. Each box is its own value on
// its own network: nothing is copied from one box to another. Both
// Ethereum-style boxes (USDC on Arbitrum, ABT on Ethereum) have their checksum
// read and are looked up on their own network, and an address that holds
// contract code is saved only when the owner confirms it. Every check runs
// before any write. The check module is the real one with an injected JSON-RPC
// caller, so nothing here reaches a network.
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import type { JsonRpcCaller } from '../../src/adapters/payment/evm-address-lookup.js';
import { createOperatorAddressCheck, type OperatorAddressCheck } from '../../src/adapters/payment/operator-address-check.js';
import { MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';

// The same address in the three spellings the checksum cares about.
const ETH_CHECKSUMMED = '0xAb12AB12Ab12AB12ab12Ab12ab12aB12AB12aB12';
const ETH_LOWER = '0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12';
const ETH_MISTYPED = '0xab12AB12Ab12AB12ab12Ab12ab12aB12AB12aB12';
const ARB_CHECKSUMMED = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const ARB_LOWER = '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d';
const ARB_MISTYPED = '0x75faf114eafb1bDbe2F0316DF893fd58CE46AA4d';
const ABT_ADDRESS = 'z6MkExampleSuffix';

const ARBITRUM_URL = 'https://arbitrum.node.example.test';
const ETHEREUM_URL = 'https://ethereum.node.example.test';

const SHAPE_SENTENCE = 'operatorAddressAbtEth must be an Ethereum address matching /^0x[0-9a-fA-F]{40}$/';
const NONE_SENTENCE = 'body must name at least one of operatorAddressEvm, operatorAddressAbt and operatorAddressAbtEth';
const CHECKSUM_SENTENCE_ETH = 'operatorAddressAbtEth does not pass its checksum, so a character is probably mistyped; copy the address from your wallet again';
const CHECKSUM_SENTENCE_ARB = 'operatorAddressEvm does not pass its checksum, so a character is probably mistyped; copy the address from your wallet again';
const CONTRACT_SENTENCE_ETH =
  'This address on Ethereum holds contract code, so it may be a contract and not an ordinary wallet. ABT sent to a contract only arrives if the contract was built to receive it. Check the address in your wallet before you save it.';
const CONTRACT_SENTENCE_ARB =
  'This address on Arbitrum holds contract code, so it may be a contract and not an ordinary wallet. USDC sent to a contract only arrives if the contract was built to receive it. Check the address in your wallet before you save it.';

async function patchSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'PATCH', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

interface CheckCall {
  readonly network: string;
  readonly address: string;
}

interface Started {
  readonly server: Server;
  readonly baseUrl: string;
  readonly repo: MemoryAccountRepository;
  readonly owner: SigningIdentity;
  readonly path: string;
  // Every question the route put to the check, in order.
  readonly checkCalls: CheckCall[];
  // Every question the check put to a node, in order.
  readonly nodeCalls: { readonly url: string; readonly address: string }[];
  readonly setEvm: ReturnType<typeof vi.spyOn>;
  readonly setAbt: ReturnType<typeof vi.spyOn>;
  readonly setAbtEth: ReturnType<typeof vi.spyOn>;
}

const servers: Server[] = [];

// `answer` says what a node returns for an address: bytecode, '0x', or a
// thrown error (the lookup could not tell).
async function startApp(answer: (address: string) => string | Error = () => '0x'): Promise<Started> {
  const repo = new MemoryAccountRepository();
  const owner = await signingIdentityFromSeed(new Uint8Array(32).fill(231));
  await repo.register({ did: owner.did, githubLogin: 'abt-eth-owner' });
  const nodeCalls: Started['nodeCalls'] = [];
  const call: JsonRpcCaller = async (url, _method, params) => {
    const address = String(params[0]);
    nodeCalls.push({ url, address });
    const out = answer(address);
    if (out instanceof Error) throw out;
    return out;
  };
  const real = createOperatorAddressCheck({ call });
  const checkCalls: CheckCall[] = [];
  const operatorAddressCheck: OperatorAddressCheck = {
    check(network, address) {
      checkCalls.push({ network, address });
      return real.check(network, address);
    },
  };
  const setEvm = vi.spyOn(repo, 'setOperatorAddressEvm');
  const setAbt = vi.spyOn(repo, 'setOperatorAddressAbt');
  const setAbtEth = vi.spyOn(repo, 'setOperatorAddressAbtEth');
  // createApp has 28 positional parameters before the check; a test that
  // wants only the account repository and the check names the rest as undefined.
  const args: unknown[] = new Array(29).fill(undefined);
  args[0] = repo;
  args[28] = operatorAddressCheck;
  const app = createApp(...(args as Parameters<typeof createApp>));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    repo,
    owner,
    path: `/accounts/${owner.did}/operator-address`,
    checkCalls,
    nodeCalls,
    setEvm,
    setAbt,
    setAbtEth,
  };
}

async function stored(s: Started): Promise<{ evm: string | null; abt: string | null; abtEth: string | null }> {
  const row = await s.repo.findByDid(s.owner.did);
  if (row === null) throw new Error('the owner row is missing');
  return { evm: row.operatorAddressEvm, abt: row.operatorAddressAbt, abtEth: row.operatorAddressAbtEth };
}

const NOTHING_SAVED = { evm: null, abt: null, abtEth: null };

describe('PATCH /accounts/:did/operator-address, the ABT-on-Ethereum box', () => {
  const savedEnv = {
    arbitrum: process.env.FREEAGENTS_USDC_RPC_URL,
    ethereum: process.env.FREEAGENTS_ABT_ETH_RPC_URL,
  };

  beforeEach(() => {
    process.env.FREEAGENTS_USDC_RPC_URL = ARBITRUM_URL;
    process.env.FREEAGENTS_ABT_ETH_RPC_URL = ETHEREUM_URL;
  });

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const [name, value] of [
      ['FREEAGENTS_USDC_RPC_URL', savedEnv.arbitrum],
      ['FREEAGENTS_ABT_ETH_RPC_URL', savedEnv.ethereum],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('(a) the owner saves operatorAddressAbtEth alone: the answer, the stored row and a fresh GET carry it, and the other two stay null', async () => {
    const s = await startApp();
    const row = await s.repo.findByDid(s.owner.did);
    const createdAt = (row as NonNullable<typeof row>).createdAt.toISOString();

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      did: s.owner.did,
      githubLogin: 'abt-eth-owner',
      createdAt,
      operatorAddressEvm: null,
      operatorAddressAbt: null,
      operatorAddressAbtEth: ETH_CHECKSUMMED,
      passkeySubject: null,
    });
    expect(await stored(s)).toEqual({ evm: null, abt: null, abtEth: ETH_CHECKSUMMED });
    const fresh = await fetch(`${s.baseUrl}/accounts/${s.owner.did}`);
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({
      did: s.owner.did,
      githubLogin: 'abt-eth-owner',
      createdAt,
      operatorAddressEvm: null,
      operatorAddressAbt: null,
      operatorAddressAbtEth: ETH_CHECKSUMMED,
    });
  });

  it('(b) saving operatorAddressEvm leaves operatorAddressAbtEth null, and saving operatorAddressAbtEth leaves operatorAddressEvm as it was', async () => {
    const s = await startApp();

    const first = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED }, s.owner);
    expect(first.status).toBe(200);
    expect(await stored(s)).toEqual({ evm: ARB_CHECKSUMMED, abt: null, abtEth: null });
    expect(s.setAbtEth).not.toHaveBeenCalled();

    const second = await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);
    expect(second.status).toBe(200);
    expect(await stored(s)).toEqual({ evm: ARB_CHECKSUMMED, abt: null, abtEth: ETH_CHECKSUMMED });
    expect(s.setEvm).toHaveBeenCalledTimes(1);
    expect(s.setEvm).toHaveBeenCalledWith(s.owner.did, ARB_CHECKSUMMED);
    expect(s.setAbtEth).toHaveBeenCalledTimes(1);
    expect(s.setAbtEth).toHaveBeenCalledWith(s.owner.did, ETH_CHECKSUMMED);
  });

  it('(c) a malformed ABT-on-Ethereum address is a 400 with the whole sentence, and what was on record stays', async () => {
    const s = await startApp();
    await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    for (const bad of ['not-an-address', '0x1234', ETH_LOWER.slice(0, 41), `${ETH_LOWER}0`, 12345, null, '']) {
      const res = await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: bad }, s.owner);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: SHAPE_SENTENCE });
    }
    expect(await stored(s)).toEqual({ evm: null, abt: null, abtEth: ETH_CHECKSUMMED });
  });

  it('(d) a checksum failure on the ABT-on-Ethereum box is a 400 with the whole sentence and nothing is written', async () => {
    const s = await startApp();

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: ETH_MISTYPED }, s.owner);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CHECKSUM_SENTENCE_ETH });
    expect(await stored(s)).toEqual(NOTHING_SAVED);
    expect(s.setAbtEth).not.toHaveBeenCalled();
    expect(s.nodeCalls).toEqual([]);
  });

  it('(d) a checksum failure on the USDC box is a 400 with the whole sentence and nothing is written', async () => {
    const s = await startApp();

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_MISTYPED }, s.owner);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CHECKSUM_SENTENCE_ARB });
    expect(await stored(s)).toEqual(NOTHING_SAVED);
    expect(s.setEvm).not.toHaveBeenCalled();
    expect(s.nodeCalls).toEqual([]);
  });

  it('(d) an all-lower-case address and a correct EIP-55 spelling of the same address both save, in both Ethereum-style boxes', async () => {
    const s = await startApp();

    const lower = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_LOWER, operatorAddressAbtEth: ETH_LOWER }, s.owner);
    expect(lower.status).toBe(200);
    expect(await stored(s)).toEqual({ evm: ARB_LOWER, abt: null, abtEth: ETH_LOWER });

    const mixed = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);
    expect(mixed.status).toBe(200);
    expect(await stored(s)).toEqual({ evm: ARB_CHECKSUMMED, abt: null, abtEth: ETH_CHECKSUMMED });
  });

  it('(e) a contract address on Ethereum without confirmContractAddress is a 409 with the whole body, and nothing is written', async () => {
    const s = await startApp(() => '0x6080604052');

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: CONTRACT_SENTENCE_ETH,
      contractAddressFields: ['operatorAddressAbtEth'],
      confirmField: 'confirmContractAddress',
    });
    expect(await stored(s)).toEqual(NOTHING_SAVED);
    expect(s.setAbtEth).not.toHaveBeenCalled();
  });

  it('(e) a contract address on Arbitrum without confirmContractAddress is a 409 naming Arbitrum and USDC, and nothing is written', async () => {
    const s = await startApp(() => '0x6080604052');

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED }, s.owner);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: CONTRACT_SENTENCE_ARB,
      contractAddressFields: ['operatorAddressEvm'],
      confirmField: 'confirmContractAddress',
    });
    expect(await stored(s)).toEqual(NOTHING_SAVED);
    expect(s.setEvm).not.toHaveBeenCalled();
  });

  it('(e) two contract addresses give one 409 that names both fields and both networks, and nothing is written', async () => {
    const s = await startApp(() => '0x6080604052');

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `${CONTRACT_SENTENCE_ARB} ${CONTRACT_SENTENCE_ETH}`,
      contractAddressFields: ['operatorAddressEvm', 'operatorAddressAbtEth'],
      confirmField: 'confirmContractAddress',
    });
    expect(await stored(s)).toEqual(NOTHING_SAVED);
  });

  it('(e) only the contract field is named when the other box holds a plain wallet', async () => {
    const s = await startApp((address) => (address === ETH_CHECKSUMMED ? '0x6080604052' : '0x'));

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: CONTRACT_SENTENCE_ETH,
      contractAddressFields: ['operatorAddressAbtEth'],
      confirmField: 'confirmContractAddress',
    });
    expect(await stored(s)).toEqual(NOTHING_SAVED);
  });

  it('(e) the same body with confirmContractAddress: true saves', async () => {
    const s = await startApp(() => '0x6080604052');

    const res = await patchSigned(
      s.baseUrl,
      s.path,
      { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED, confirmContractAddress: true },
      s.owner,
    );

    expect(res.status).toBe(200);
    expect(await stored(s)).toEqual({ evm: ARB_CHECKSUMMED, abt: null, abtEth: ETH_CHECKSUMMED });
  });

  it('(e) confirmContractAddress that is not exactly true does not confirm: the string "true", 1 and an object each stay a 409', async () => {
    for (const notTrue of ['true', 1, {}, 'yes']) {
      const s = await startApp(() => '0x6080604052');
      const res = await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: ETH_CHECKSUMMED, confirmContractAddress: notTrue }, s.owner);
      expect(res.status).toBe(409);
      expect(await stored(s)).toEqual(NOTHING_SAVED);
    }
  });

  it('(e) the check was asked on Ethereum for the ABT box and on Arbitrum for the USDC box, with each box\'s own address, and each node was asked at its own URL', async () => {
    const s = await startApp(() => '0x6080604052');

    await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    expect(s.checkCalls).toEqual([
      { network: 'arbitrum', address: ARB_CHECKSUMMED },
      { network: 'ethereum', address: ETH_CHECKSUMMED },
    ]);
    expect(s.nodeCalls).toEqual([
      { url: ARBITRUM_URL, address: ARB_CHECKSUMMED },
      { url: ETHEREUM_URL, address: ETH_CHECKSUMMED },
    ]);
  });

  it('(f) holdsContractCode false saves with no confirmation', async () => {
    const s = await startApp(() => '0x');

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    expect(res.status).toBe(200);
    expect(await stored(s)).toEqual({ evm: ARB_CHECKSUMMED, abt: null, abtEth: ETH_CHECKSUMMED });
    expect(s.nodeCalls.length).toBe(2);
  });

  it('(f) holdsContractCode null (the node could not tell) saves with no confirmation', async () => {
    const s = await startApp(() => new Error('node down'));

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    expect(res.status).toBe(200);
    expect(await stored(s)).toEqual({ evm: ARB_CHECKSUMMED, abt: null, abtEth: ETH_CHECKSUMMED });
    expect(s.nodeCalls.length).toBe(2);
  });

  it('(f) holdsContractCode null because no node is configured saves with no confirmation', async () => {
    delete process.env.FREEAGENTS_USDC_RPC_URL;
    delete process.env.FREEAGENTS_ABT_ETH_RPC_URL;
    const s = await startApp(() => '0x6080604052');

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);

    expect(res.status).toBe(200);
    expect(await stored(s)).toEqual({ evm: ARB_CHECKSUMMED, abt: null, abtEth: ETH_CHECKSUMMED });
    expect(s.nodeCalls).toEqual([]);
  });

  describe('(g) a body with one good field and one bad field writes neither', () => {
    it('a good USDC address with a malformed ABT-on-Ethereum address', async () => {
      const s = await startApp();
      const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: 'nope' }, s.owner);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: SHAPE_SENTENCE });
      expect(await stored(s)).toEqual(NOTHING_SAVED);
      expect(s.setEvm).not.toHaveBeenCalled();
    });

    it('a good USDC address with an ABT-on-Ethereum address that fails its checksum', async () => {
      const s = await startApp();
      const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_MISTYPED }, s.owner);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: CHECKSUM_SENTENCE_ETH });
      expect(await stored(s)).toEqual(NOTHING_SAVED);
      expect(s.setEvm).not.toHaveBeenCalled();
    });

    it('a good USDC address with an ABT-on-Ethereum contract address that is not confirmed', async () => {
      const s = await startApp((address) => (address === ETH_CHECKSUMMED ? '0x6080604052' : '0x'));
      const res = await patchSigned(s.baseUrl, s.path, { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbtEth: ETH_CHECKSUMMED }, s.owner);
      expect(res.status).toBe(409);
      expect(await stored(s)).toEqual(NOTHING_SAVED);
      expect(s.setEvm).not.toHaveBeenCalled();
    });

    it('a good ABT-on-Ethereum address with a malformed ArcBlock address', async () => {
      const s = await startApp();
      const res = await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: ETH_CHECKSUMMED, operatorAddressAbt: 'has a space' }, s.owner);
      expect(res.status).toBe(400);
      expect(await stored(s)).toEqual(NOTHING_SAVED);
      expect(s.setAbtEth).not.toHaveBeenCalled();
    });

    it('a good ArcBlock address with a USDC address that fails its checksum', async () => {
      const s = await startApp();
      const res = await patchSigned(s.baseUrl, s.path, { operatorAddressAbt: ABT_ADDRESS, operatorAddressEvm: ARB_MISTYPED }, s.owner);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: CHECKSUM_SENTENCE_ARB });
      expect(await stored(s)).toEqual(NOTHING_SAVED);
      expect(s.setAbt).not.toHaveBeenCalled();
    });

    it('all three good fields save together, each through its own call', async () => {
      const s = await startApp();
      const res = await patchSigned(
        s.baseUrl,
        s.path,
        { operatorAddressEvm: ARB_CHECKSUMMED, operatorAddressAbt: ABT_ADDRESS, operatorAddressAbtEth: ETH_CHECKSUMMED },
        s.owner,
      );
      expect(res.status).toBe(200);
      expect(await stored(s)).toEqual({ evm: ARB_CHECKSUMMED, abt: ABT_ADDRESS, abtEth: ETH_CHECKSUMMED });
    });
  });

  it('(h) an unsigned request naming only operatorAddressAbtEth is a 401 and the setter is never called', async () => {
    const s = await startApp();

    const res = await fetch(`${s.baseUrl}${s.path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorAddressAbtEth: ETH_CHECKSUMMED }),
    });

    expect(res.status).toBe(401);
    expect(s.setAbtEth).not.toHaveBeenCalled();
    expect(await stored(s)).toEqual(NOTHING_SAVED);
    expect(s.nodeCalls).toEqual([]);
  });

  it('(h) a registered stranger naming only operatorAddressAbtEth for another account is a 403 and the setter is never called', async () => {
    const s = await startApp();
    const stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(232));
    await s.repo.register({ did: stranger.did, githubLogin: 'abt-eth-stranger' });

    const res = await patchSigned(s.baseUrl, s.path, { operatorAddressAbtEth: ETH_CHECKSUMMED }, stranger);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'an account may only set its own operator address' });
    expect(s.setAbtEth).not.toHaveBeenCalled();
    expect(await stored(s)).toEqual(NOTHING_SAVED);
    expect(s.nodeCalls).toEqual([]);
  });

  it('(j) a body naming none of the three fields is a 400 with the whole sentence', async () => {
    const s = await startApp();

    for (const body of [{}, { confirmContractAddress: true }]) {
      const res = await patchSigned(s.baseUrl, s.path, body, s.owner);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: NONE_SENTENCE });
    }
    expect(await stored(s)).toEqual(NOTHING_SAVED);
  });
});
