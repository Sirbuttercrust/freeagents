// The checksum check an Ethereum-style payout address gets before it is
// saved. The one place case is read on purpose: an address spelled all
// lower case or all upper case carries no checksum, a mixed-case one
// carries EIP-55's. The keccak function is handed in, so the domain keeps
// its no-vendor-import rule; the test passes ethers' own.
import { keccak256 } from 'ethers';
import { describe, expect, it } from 'vitest';
import { evmAddressChecksumOk } from '../../src/domain/evm-address.js';

const keccak = (data: Uint8Array): string => keccak256(data);

// The examples published in EIP-55 itself: four with no checksum (all caps,
// all lower) and four mixed-case ones.
const EIP55_ALL_CAPS = ['0x52908400098527886E0F7030069857D2E4169EE7', '0x8617E340B3D01FA5F11F306F4090FD50E238070D'];
const EIP55_ALL_LOWER = ['0xde709f2102306220921060314715629080e2fb77', '0x27b1fdb04752bbc536007a920d24acb045561c26'];
const EIP55_MIXED = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];

describe('evmAddressChecksumOk', () => {
  it.each(EIP55_MIXED)('accepts the EIP-55 example %s', (address) => {
    expect(evmAddressChecksumOk(address, keccak)).toBe(true);
  });

  it.each([...EIP55_ALL_CAPS, ...EIP55_ALL_LOWER])('accepts %s, which carries no checksum', (address) => {
    expect(evmAddressChecksumOk(address, keccak)).toBe(true);
  });

  it('refuses a checksummed address with one letter flipped to the other case', () => {
    const original = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    // Character 3 is a lower-case 'a' in the original; upper-casing it breaks the checksum.
    const flipped = `${original.slice(0, 3)}${original[3]!.toUpperCase()}${original.slice(4)}`;
    expect(flipped).not.toBe(original);
    expect(evmAddressChecksumOk(flipped, keccak)).toBe(false);
  });

  it.each([
    ['too short', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA'],
    ['too long', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed00'],
    ['no 0x prefix', '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    ['a non-hex character', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg'],
    ['empty', ''],
  ])('refuses an address that is %s', (_label, address) => {
    expect(evmAddressChecksumOk(address, keccak)).toBe(false);
  });
});
