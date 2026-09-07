// S5: the durable record of a request signature that has already verified
// once, so the same signature cannot verify a second time (replay).
// Storage interface only, mirroring usdc-half-paid-storage-types.ts's own
// split of interface from driver so tests inject a memory implementation
// without touching this shape.
//
// The spend key is (keyid, signatureHash): signatureHash is a hash of the
// signature bytes themselves, scoped by keyid so two different signers can
// never collide with one another, and the same signer re-presenting the
// same signature bytes is exactly the case this refuses. `created` rides
// alongside the key so a row outside the freshness window can be pruned --
// a row is useless once the signature it names could no longer verify on
// freshness grounds anyway, and a store that grows forever is a slow
// outage.
export interface SignatureSpendRow {
  readonly keyid: string;
  readonly signatureHash: string;
  readonly created: number;
}

export interface SignatureSpendStorage {
  // Null when this (keyid, signatureHash) pair has never been recorded.
  findByKeyidAndHash(keyid: string, signatureHash: string): Promise<SignatureSpendRow | null>;
  // Records a signature as spent. Called only once findByKeyidAndHash has
  // already answered null for the same pair in this same verify() call, so
  // a driver never needs to treat a duplicate record() as anything but a
  // caller error.
  record(row: SignatureSpendRow): Promise<void>;
}
