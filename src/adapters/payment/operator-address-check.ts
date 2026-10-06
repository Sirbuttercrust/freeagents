// One check for both Ethereum-style address boxes an owner fills in: the USDC
// box (Arbitrum) and the ABT box (Ethereum). It reads the address's checksum,
// then asks that box's own network a free public question: does this address
// hold contract code? The answer is advice for a person about to save. A node
// that is unset, slow or confusing answers null ("could not tell") and the
// check never throws, so a lookup problem cannot stop a save.
//
// The RPC variables are the ones the two rail adapters already read. They are
// read when a check is asked, never when it is built, so a deployment that
// sets one later is still honoured and a test that sets none asks no node.
import { checksumOk, lookupEvmAddress, type JsonRpcCaller } from './evm-address-lookup.js';

export type OperatorAddressNetwork = 'arbitrum' | 'ethereum';

export interface OperatorAddressCheckResult {
  readonly checksumOk: boolean;
  readonly holdsContractCode: boolean | null;
}

export interface OperatorAddressCheck {
  check(network: OperatorAddressNetwork, address: string): Promise<OperatorAddressCheckResult>;
}

export interface OperatorAddressCheckOptions {
  readonly call?: JsonRpcCaller;
  readonly timeoutMs?: number;
}

const RPC_VARIABLE: Readonly<Record<OperatorAddressNetwork, string>> = {
  arbitrum: 'FREEAGENTS_USDC_RPC_URL',
  ethereum: 'FREEAGENTS_ABT_ETH_RPC_URL',
};

export function createOperatorAddressCheck(options: OperatorAddressCheckOptions = {}): OperatorAddressCheck {
  return {
    async check(network, address) {
      // A mistyped address asks no node: the checksum already says no.
      if (!checksumOk(address)) return { checksumOk: false, holdsContractCode: null };
      const rpcUrl = process.env[RPC_VARIABLE[network]] || '';
      if (rpcUrl === '') return { checksumOk: true, holdsContractCode: null };
      try {
        const found = await lookupEvmAddress(rpcUrl, address, {
          ...(options.call !== undefined ? { call: options.call } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        return { checksumOk: true, holdsContractCode: found.holdsContractCode };
      } catch {
        return { checksumOk: true, holdsContractCode: null };
      }
    },
  };
}
