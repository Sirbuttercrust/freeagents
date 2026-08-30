// Issue 84: invariants 7 and 8 (MISSION.md), held by a test rather than by
// good intentions, the same idea as tests/api/capabilities-invariant2.test.ts
// for invariant 2. Invariant 7: ArcBlock is "visible, never required."
// Invariant 8: "Sign-in is GitHub OAuth or a passkey." Together they mean a
// wallet-based method may never be the one thing standing between a user and
// sign-in.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { SIGN_IN_METHODS } from '../../src/domain/sign-in-methods.js';

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function portOf(srv: Server): number {
  return (srv.address() as AddressInfo).port;
}

describe('sign-in methods, invariants 7 and 8', () => {
  it('no wallet-based method may ever be required', () => {
    for (const method of SIGN_IN_METHODS) {
      if (method.walletBased) {
        expect(method.required, `${method.id} is wallet-based and must never be required`).toBe(false);
      }
    }
  });

  it('at least one non-wallet method is always present', () => {
    const nonWallet = SIGN_IN_METHODS.filter((method) => !method.walletBased);
    expect(nonWallet.length).toBeGreaterThan(0);
  });

  it('at least one non-wallet method is required, so a wallet is never the only path offered', () => {
    const requiredNonWallet = SIGN_IN_METHODS.filter((method) => method.required && !method.walletBased);
    expect(requiredNonWallet.length).toBeGreaterThan(0);
  });

  it('holds over the wire too: GET /sign-in-methods can never publish a required wallet method', async () => {
    const server = await listen(createApp());
    try {
      const baseUrl = `http://127.0.0.1:${portOf(server)}`;
      const res = await fetch(`${baseUrl}/sign-in-methods`);
      const body = (await res.json()) as { methods: Array<{ id: string; required: boolean; walletBased: boolean }> };
      for (const method of body.methods) {
        if (method.walletBased) {
          expect(method.required, `${method.id} is wallet-based and must never be required`).toBe(false);
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
