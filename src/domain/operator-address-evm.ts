// S3, Ruling 4: EVM operator address shape (PATCH /accounts/:did/operator-address).
// An ArcBlock DID and an EVM address are different chain address shapes
// entirely (ABT resolves its own recipient by deriving the suffix off the
// hired agent's operatorDid, src/domain/agent.ts's didSuffix; this file
// exists for the USDC rail's separate, stored column). Total and never
// throws, mirroring src/domain/operator-did.ts's isValidOperatorDid.

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isValidOperatorAddressEvm(value: string): boolean {
  return EVM_ADDRESS_PATTERN.test(value);
}
