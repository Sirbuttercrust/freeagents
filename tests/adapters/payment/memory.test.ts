// Memory payment rail (brief scope item 6): records requests and confirms
// on command, for the API tests P4 will write. No chain call, ever; a test
// drives confirm() directly through setConfirmed.
import { describe, expect, it } from 'vitest';
import { createMemoryPaymentRail } from '../../../src/adapters/payment/memory.js';

describe('createMemoryPaymentRail: createRequest records the request', () => {
  it('returns a PaymentRequest naming the rail, job, and leg supplied', async () => {
    const rail = createMemoryPaymentRail();
    const request = await rail.createRequest({
      jobId: 'job_1',
      leg: 'deposit',
      operatorAddress: 'z1Operator',
      amountToken: '2',
      feeToken: '0.06',
    });
    expect(request.rail).toBe('abt');
    expect(request.jobId).toBe('job_1');
    expect(request.leg).toBe('deposit');
  });
});

describe('createMemoryPaymentRail: onWalletResponse returns a distinct ref per call', () => {
  it('returns a PaymentRef with a hash, different for each call', async () => {
    const rail = createMemoryPaymentRail();
    const ref1 = await rail.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx: 'x' });
    const ref2 = await rail.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'balance', finalTx: 'y' });
    expect(ref1.rail).toBe('abt');
    expect(ref1.hash).not.toBe(ref2.hash);
  });
});

describe('createMemoryPaymentRail: confirm is driven by setConfirmed, not by any external truth', () => {
  it('a fresh ref is unconfirmed until setConfirmed marks it true', async () => {
    const rail = createMemoryPaymentRail();
    const ref = await rail.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx: 'x' });

    const before = await rail.confirm(ref);
    expect(before.confirmed).toBe(false);

    rail.setConfirmed(ref.hash, true);
    const after = await rail.confirm(ref);
    expect(after.confirmed).toBe(true);
  });

  it('confirm is idempotent: calling it twice after setConfirmed answers identically both times', async () => {
    const rail = createMemoryPaymentRail();
    const ref = await rail.onWalletResponse({ rail: 'abt', jobId: 'job_1', leg: 'deposit', finalTx: 'x' });
    rail.setConfirmed(ref.hash, true);

    const first = await rail.confirm(ref);
    const second = await rail.confirm(ref);
    expect(first).toEqual(second);
  });
});
