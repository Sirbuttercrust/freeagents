// P8d: the single most dangerous guard in this card. findByGithubLogin and
// findByPasskeySubject must never resolve a null or empty subject to a row
// whose own column happens to be null: every passkey-only provisioned
// account has a null githubLogin, and every GitHub-only provisioned account
// has a null passkeySubject, so resolving "no subject" to "the first row
// with a null column" would let one stranger's session resolve to a
// DIFFERENT stranger's account. Wrong resolution here means acting as them
// (app.ts's resolveActingParty joins straight through these two methods),
// so this is an authentication bypass if the guard is missing, not a
// cosmetic defect. Both drivers get the identical proof.
import { describe, expect, it } from 'vitest';
import { MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import type { AccountRepository } from '../../src/adapters/storage/types.js';

describe('MemoryAccountRepository: null-subject lookup guard (P8d)', () => {
  function repoWithTwoNullLoginAccounts(): AccountRepository {
    const repo = new MemoryAccountRepository();
    return repo;
  }

  it('findByGithubLogin(null) never resolves to a row whose githubLogin is null', async () => {
    const repo = repoWithTwoNullLoginAccounts();
    await repo.register({ did: 'did:abt:p8d-null-login-a', passkeySubject: 'p8d-passkey-a' });
    await repo.register({ did: 'did:abt:p8d-null-login-b', passkeySubject: 'p8d-passkey-b' });

    const resolved = await repo.findByGithubLogin(null);
    expect(resolved).toBeNull();
  });

  it('findByGithubLogin("") never resolves to a row whose githubLogin is null', async () => {
    const repo = repoWithTwoNullLoginAccounts();
    await repo.register({ did: 'did:abt:p8d-empty-login-a', passkeySubject: 'p8d-passkey-c' });

    const resolved = await repo.findByGithubLogin('');
    expect(resolved).toBeNull();
  });

  it('findByPasskeySubject(null) never resolves to a row whose passkeySubject is null', async () => {
    const repo = repoWithTwoNullLoginAccounts();
    await repo.register({ did: 'did:abt:p8d-null-passkey-a', githubLogin: 'p8d-login-a' });
    await repo.register({ did: 'did:abt:p8d-null-passkey-b', githubLogin: 'p8d-login-b' });

    const resolved = await repo.findByPasskeySubject(null);
    expect(resolved).toBeNull();
  });

  it('findByPasskeySubject("") never resolves to a row whose passkeySubject is null', async () => {
    const repo = repoWithTwoNullLoginAccounts();
    await repo.register({ did: 'did:abt:p8d-empty-passkey-a', githubLogin: 'p8d-login-c' });

    const resolved = await repo.findByPasskeySubject('');
    expect(resolved).toBeNull();
  });

  it('a real, non-null githubLogin still resolves correctly (the guard does not break the ordinary path)', async () => {
    const repo = repoWithTwoNullLoginAccounts();
    await repo.register({ did: 'did:abt:p8d-real-login', githubLogin: 'p8d-real-login-value' });

    const resolved = await repo.findByGithubLogin('p8d-real-login-value');
    expect(resolved?.did).toBe('did:abt:p8d-real-login');
  });

  it('a real, non-null passkeySubject still resolves correctly (the guard does not break the ordinary path)', async () => {
    const repo = repoWithTwoNullLoginAccounts();
    await repo.register({ did: 'did:abt:p8d-real-passkey', passkeySubject: 'p8d-real-passkey-value' });

    const resolved = await repo.findByPasskeySubject('p8d-real-passkey-value');
    expect(resolved?.did).toBe('did:abt:p8d-real-passkey');
  });
});
