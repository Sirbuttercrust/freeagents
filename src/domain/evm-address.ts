// Checksum check for an Ethereum-style address (EIP-55). Pure: the
// Keccak-256 it needs is passed in, so the domain imports no vendor code
// and the adapter that calls this hands in its own hash function.
//
// This is the one place an address's letter case is read on purpose.
// Everywhere else addresses compare without case. An address written all
// lower case or all upper case carries no checksum and is accepted by
// shape; a mixed-case one claims a checksum and must match it, because a
// single mistyped letter is the common way a payout address goes wrong.

const EVM_ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

export type Keccak256Hex = (data: Uint8Array) => string;

export function evmAddressChecksumOk(address: string, keccak256: Keccak256Hex): boolean {
  if (!EVM_ADDRESS_SHAPE.test(address)) return false;
  const digits = address.slice(2);
  if (digits === digits.toLowerCase() || digits === digits.toUpperCase()) return true;

  const hash = keccak256(new TextEncoder().encode(digits.toLowerCase())).replace(/^0x/, '');
  for (let i = 0; i < digits.length; i += 1) {
    const char = digits[i] as string;
    if (/[0-9]/.test(char)) continue;
    const shouldBeUpper = Number.parseInt(hash[i] as string, 16) >= 8;
    if ((char === char.toUpperCase()) !== shouldBeUpper) return false;
  }
  return true;
}
