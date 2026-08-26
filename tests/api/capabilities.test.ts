// R-23: GET /capabilities states the identity boundary before a user
// invests effort (accept clause 3). Public, session-free, and permanently
// so - see src/api/app.ts's comment on the route for why requiring sign-in
// to read it would be circular.
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryOperatorRepository } from '../../src/adapters/storage/memory.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('GET /capabilities', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp(new MemoryOperatorRepository()).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('answers 200 with exactly { capabilities }, no headers', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['capabilities']);
  });

  it('lists all 4 capabilities in declared order', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    const body = (await res.json()) as { capabilities: Array<Record<string, unknown>> };
    expect(body.capabilities).toHaveLength(4);
    expect(body.capabilities.map((c) => c.capability)).toEqual(['browse', 'verify', 'hire', 'list']);
  });

  it('every entry has exactly the pinned key set', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    const body = (await res.json()) as { capabilities: Array<Record<string, unknown>> };
    for (const entry of body.capabilities) {
      expect(Object.keys(entry).sort()).toEqual(
        ['capability', 'identityRequired', 'signInMethods', 'statement', 'walletRequired'].sort(),
      );
    }
  });

  it('browse and verify need no identity', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    const body = (await res.json()) as { capabilities: Array<Record<string, unknown>> };
    for (const key of ['browse', 'verify']) {
      const entry = body.capabilities.find((c) => c.capability === key);
      expect(entry?.identityRequired).toBe(false);
      expect(entry?.signInMethods).toEqual([]);
    }
  });

  it('hire and list require an identity, via GitHub OAuth or a passkey', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    const body = (await res.json()) as { capabilities: Array<Record<string, unknown>> };
    for (const key of ['hire', 'list']) {
      const entry = body.capabilities.find((c) => c.capability === key);
      expect(entry?.identityRequired).toBe(true);
      expect(entry?.signInMethods).toEqual(['github-oauth', 'passkey']);
    }
  });

  it('invariant 7 on the wire: no entry ever requires a wallet', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    const body = (await res.json()) as { capabilities: Array<Record<string, unknown>> };
    for (const entry of body.capabilities) {
      expect(entry.walletRequired).toBe(false);
    }
    // Same negation-aware pattern as tests/domain/access.test.ts: the wire
    // legitimately carries the phrase "no wallet is required", so a naive
    // substring match on "wallet is required" would false-positive on the
    // very sentence stating the invariant.
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toMatch(/(?<!no )wallet is required|seed phrase|connect a wallet|install .{0,20}wallet/);
  });

  it('mints no session: no Set-Cookie on the response', async () => {
    const res = await fetch(`${baseUrl}/capabilities`);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('structural pin: the domain file sets no wallet requirement and imports nothing, and the route serves the domain policy directly', () => {
    const accessSrc = readFileSync(join(here, '../../src/domain/access.ts'), 'utf8');
    expect(/walletRequired:\s*true/.test(accessSrc)).toBe(false);
    expect(accessSrc).not.toMatch(/^\s*import /m);
    expect(accessSrc).not.toMatch(/\brequire\(/);

    const appSrc = readFileSync(join(here, '../../src/api/app.ts'), 'utf8');
    expect(appSrc).toContain('accessPolicy().map(capabilityProjection)');
  });
});
