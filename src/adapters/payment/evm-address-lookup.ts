// Asks an Ethereum-style network whether an address holds contract code, so
// a payout address that is really a contract can get a plain warning before
// it is saved. The answer is advice: a slow, failing or confusing node
// answers `null` ("could not tell") and never throws, so a lookup problem
// cannot stop a person from saving an address they have confirmed.
//
// The JSON-RPC call is injectable so tests never open a network connection.
import { keccak256 } from 'ethers';
import { evmAddressChecksumOk } from '../../domain/evm-address.js';

// The domain's checksum check with ethers' Keccak-256 handed in, so a caller
// outside the domain has one function to call before it looks an address up.
export function checksumOk(address: string): boolean {
  return evmAddressChecksumOk(address, (data) => keccak256(data));
}

export const LOOKUP_TIMEOUT_MS = 5_000;

export type JsonRpcCaller = (
  rpcUrl: string,
  method: string,
  params: readonly unknown[],
  signal: AbortSignal,
) => Promise<unknown>;

export interface EvmAddressLookupOptions {
  readonly call?: JsonRpcCaller;
  readonly timeoutMs?: number;
}

export interface EvmAddressLookupResult {
  // true: the address holds contract code. false: it holds none (a plain
  // account). null: the lookup could not tell.
  readonly holdsContractCode: boolean | null;
}

const HEX_CODE = /^0x[0-9a-fA-F]*$/;

const fetchJsonRpc: JsonRpcCaller = async (rpcUrl, method, params, signal) => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!response.ok) throw new Error(`the node answered HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
  if (body.error !== undefined && body.error !== null) {
    throw new Error(`the node answered an error for ${method}`);
  }
  return body.result;
};

export async function lookupEvmAddress(
  rpcUrl: string,
  address: string,
  options: EvmAddressLookupOptions = {},
): Promise<EvmAddressLookupResult> {
  const call = options.call ?? fetchJsonRpc;
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A caller that ignores its signal must still not hold the save, so the
  // timeout also settles a race of its own.
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('the address lookup timed out'));
    }, timeoutMs);
  });
  const work = call(rpcUrl, 'eth_getCode', [address, 'latest'], controller.signal);
  // The loser of the race must not surface as an unhandled rejection.
  work.catch(() => undefined);
  timedOut.catch(() => undefined);
  try {
    const code = await Promise.race([work, timedOut]);
    if (typeof code !== 'string' || !HEX_CODE.test(code)) return { holdsContractCode: null };
    return { holdsContractCode: code !== '0x' };
  } catch {
    return { holdsContractCode: null };
  } finally {
    clearTimeout(timer);
  }
}
