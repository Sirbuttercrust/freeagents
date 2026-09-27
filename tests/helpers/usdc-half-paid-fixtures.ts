// Shared by tests/api/job-payment-usdc.test.ts (Make 2) and
// tests/web/usdc-wallet.test.ts (Make 3): a STATEFUL fake half-paid
// store, unlike the no-op fixture other USDC test files use elsewhere.
// These tests need what confirm() actually wrote to come back out of
// read(), and clear() to actually remove it.
import type { UsdcHalfPaidRow, UsdcHalfPaidStorage } from '../../src/adapters/payment/usdc-half-paid-storage-types.js';

export function fakeHalfPaidStorage(): UsdcHalfPaidStorage {
  const rows = new Map<string, UsdcHalfPaidRow>();
  function key(jobId: string, leg: 'deposit' | 'balance'): string {
    return `${jobId}:${leg}`;
  }
  return {
    async record(row) {
      rows.set(key(row.jobId, row.leg), { ...row });
    },
    async read(jobId, leg) {
      return rows.get(key(jobId, leg)) ?? null;
    },
    async clear(jobId, leg) {
      rows.delete(key(jobId, leg));
    },
  };
}
