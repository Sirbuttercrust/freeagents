// DID Connect session/token storage (this card's scope item 5). The shape
// is dictated by @arcblock/did-connect-js's WalletHandlers/BaseHandler,
// which call exactly these methods on whatever `tokenStorage` object it is
// given (confirmed by reading node_modules/@arcblock/did-connect-js/dist,
// and matching the MemStorage in the wallet-test reference). `on`/`emit`
// exist because BaseHandler's constructor calls `tokenStorage.on(...)`;
// the working reference no-ops them and the flow still completes end to
// end, so a correct implementation only needs the CRUD half to function.
import { describe, expect, it } from 'vitest';
import { createMemoryDidConnectStorage } from '../../../src/adapters/payment/session-storage-memory.js';

describe('createMemoryDidConnectStorage: create/read round-trip', () => {
  it('create() returns a row with the token and status supplied, read() returns the same row', async () => {
    const storage = createMemoryDidConnectStorage();
    const created = await storage.create('tok1', 'created');
    expect(created.token).toBe('tok1');
    expect(created.status).toBe('created');

    const read = await storage.read('tok1');
    expect(read).toEqual(created);
  });

  it('create() defaults status to "created" when omitted', async () => {
    const storage = createMemoryDidConnectStorage();
    const created = await storage.create('tok2');
    expect(created.status).toBe('created');
  });

  it('read() on an unknown token returns null', async () => {
    const storage = createMemoryDidConnectStorage();
    expect(await storage.read('nope')).toBeNull();
  });
});

describe('createMemoryDidConnectStorage: update merges fields onto the existing row', () => {
  it('update() merges new keys without dropping the ones already stored', async () => {
    const storage = createMemoryDidConnectStorage();
    await storage.create('tok1', 'created');
    const updated = await storage.update('tok1', { did: 'did:abt:zBuyer', challenge: 'abc' });
    expect(updated.token).toBe('tok1');
    expect(updated.status).toBe('created');
    expect(updated.did).toBe('did:abt:zBuyer');
    expect(updated.challenge).toBe('abc');

    const updatedAgain = await storage.update('tok1', { status: 'scanned' });
    expect(updatedAgain.status).toBe('scanned');
    // The earlier fields survive a later, unrelated update.
    expect(updatedAgain.did).toBe('did:abt:zBuyer');
  });

  it('update() on an unknown token still creates a row (matches the library calling update before any create in edge cases)', async () => {
    const storage = createMemoryDidConnectStorage();
    const updated = await storage.update('never-created', { status: 'succeed' });
    expect(updated.token).toBe('never-created');
    expect(updated.status).toBe('succeed');
  });
});

describe('createMemoryDidConnectStorage: delete', () => {
  it('delete() removes the row; read() afterwards returns null', async () => {
    const storage = createMemoryDidConnectStorage();
    await storage.create('tok1', 'created');
    await storage.delete('tok1');
    expect(await storage.read('tok1')).toBeNull();
  });

  it('delete() on an unknown token is a no-op, not a throw', async () => {
    const storage = createMemoryDidConnectStorage();
    await expect(storage.delete('never-existed')).resolves.toBeUndefined();
  });
});

describe('createMemoryDidConnectStorage: exist', () => {
  it('exist() is true for a known token with no did filter', async () => {
    const storage = createMemoryDidConnectStorage();
    await storage.create('tok1', 'created');
    expect(await storage.exist('tok1')).toBe(true);
  });

  it('exist() with a did filter matches only when the stored row carries that did', async () => {
    const storage = createMemoryDidConnectStorage();
    await storage.create('tok1', 'created');
    await storage.update('tok1', { did: 'did:abt:zBuyer' });
    expect(await storage.exist('tok1', 'did:abt:zBuyer')).toBe(true);
    expect(await storage.exist('tok1', 'did:abt:zSomeoneElse')).toBe(false);
  });

  it('exist() on an unknown token is false', async () => {
    const storage = createMemoryDidConnectStorage();
    expect(await storage.exist('nope')).toBe(false);
  });
});

describe('createMemoryDidConnectStorage: on/emit are present (BaseHandler wires to them at construction)', () => {
  it('on and emit exist as callable no-op-safe methods', () => {
    const storage = createMemoryDidConnectStorage();
    expect(typeof storage.on).toBe('function');
    expect(typeof storage.emit).toBe('function');
    expect(() => storage.on('create', () => {})).not.toThrow();
    expect(() => storage.emit('create', { token: 'tok1' })).not.toThrow();
  });
});
