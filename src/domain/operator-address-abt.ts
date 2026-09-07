// P8c: the ABT operator address shape is the DID suffix shape (Ruling 1,
// src/adapters/payment/abt-did-connect.ts's own comment: an ArcBlock DID
// address IS a chain account address, verified by execution against
// @arcblock/did). isValidOperatorDid already forces every Account DID into
// did:abt:<suffix> shape; this reuses that exact bound on the suffix alone,
// rather than inventing a second opinion about a shape src/domain/operator-
// did.ts already owns. Total and never throws, mirroring both
// isValidOperatorDid and isValidOperatorAddressEvm.

import { isValidOperatorDid } from './operator-did.js';

const DID_ABT_PREFIX = 'did:abt:';

export function isValidOperatorAddressAbt(value: string): boolean {
  // The address is the bare suffix, never the full did:abt:<suffix> form
  // (Ruling 1): a value that already carries the prefix is a DID, not an
  // address, and refused here rather than double-prefixed and accidentally
  // accepted as a suffix containing a colon.
  if (value.startsWith(DID_ABT_PREFIX)) return false;
  return isValidOperatorDid(`${DID_ABT_PREFIX}${value}`);
}
