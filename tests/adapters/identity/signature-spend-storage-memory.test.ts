// S5+S6: the durable signature-spend record (one-shot replay refusal).
// createMemorySignatureSpendStorage's own CRUD contract, mirroring
// tests/adapters/payment/session-storage-memory.test.ts's pattern.
import { describe, expect, it } from 'vitest';
import { createMemorySignatureSpendStorage } from '../../../src/adapters/identity/signature-spend-storage-memory.js';

describe('createMemorySignatureSpendStorage', () => {
  it('findByKeyidAndHash on an unrecorded pair is null', async () => {
    const storage = createMemorySignatureSpendStorage();
    expect(await storage.findByKeyidAndHash('keyid-1', 'hash-1')).toBeNull();
  });

  it('record() then findByKeyidAndHash() with the SAME (keyid, hash) round-trips the row', async () => {
    const storage = createMemorySignatureSpendStorage();
    await storage.record({ keyid: 'keyid-1', signatureHash: 'hash-1', created: 1700000000 });

    const row = await storage.findByKeyidAndHash('keyid-1', 'hash-1');

    expect(row).toEqual({ keyid: 'keyid-1', signatureHash: 'hash-1', created: 1700000000 });
  });

  it('the same signatureHash under a DIFFERENT keyid is a distinct row (scoped by keyid)', async () => {
    const storage = createMemorySignatureSpendStorage();
    await storage.record({ keyid: 'keyid-1', signatureHash: 'hash-shared', created: 1700000000 });

    expect(await storage.findByKeyidAndHash('keyid-2', 'hash-shared')).toBeNull();
  });

  it('the same keyid with a DIFFERENT signatureHash is a distinct row (scoped by signature)', async () => {
    const storage = createMemorySignatureSpendStorage();
    await storage.record({ keyid: 'keyid-1', signatureHash: 'hash-a', created: 1700000000 });

    expect(await storage.findByKeyidAndHash('keyid-1', 'hash-b')).toBeNull();
  });
});
