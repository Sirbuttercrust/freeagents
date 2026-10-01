// What a locked ABT price means, in one place, for both ABT rails (the
// ArcBlock-chain rail and the ABT-on-Ethereum rail): how long it lives
// and the three sentences a payment is refused with when the lock does not
// hold. Neither rail keeps its own copy, so the two cannot drift.

// How long a locked ABT price stays valid: long enough to open a wallet
// and approve, short enough that a buyer cannot sit on a quoted ABT price
// as a free option at the owner's expense while the market moves.
export const ABT_QUOTE_LOCK_LIFETIME_MS = 15 * 60 * 1000;

export const NO_LOCK_MESSAGE = 'This payment has no locked ABT price. Start the payment again.';
export const LOCK_EXPIRED_MESSAGE = 'The ABT price for this payment expired. Start the payment again for a fresh price.';
export const PRICE_CHANGED_MESSAGE = 'The agreed price changed after this payment started. Start the payment again.';
