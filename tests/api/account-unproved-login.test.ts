// FIX-B62b: a GitHub login nobody proved stops acting as one. Accounts
// registered before logins needed proof (FIX-B62a) hold a login a caller
// typed. The migration moves that text to Account.unprovedGithubLogin and
// clears githubLogin, so every lookup (which reads githubLogin only) sees
// proved logins and nothing else. The one exception is the row a GitHub
// sign-in itself made: its DID is the one the platform derives from the
// login, so the next sign-in for that login re-proves it.
//
// Every legacy row below is seeded the way the migration leaves it:
// repo.register with unprovedGithubLogin and no githubLogin.
import type { Server } from 'node:http';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { AccountAlreadyExistsError, type AccountRepository } from '../../src/adapters/storage/types.js';
import { MemoryAccountRepository, MemoryAgentRepository, MemoryJobRepository } from '../../src/adapters/storage/memory.js';
import { createJob } from '../../src/domain/job.js';
import { fakeGitHubConfig, fakeGitHubFetch, mintSessionToken } from '../helpers/session-fixtures.js';

const STRANGER_DID = 'did:abt:zNStrangerLegacyRowDidForB62b';
const PUBLIC_KEYS = ['createdAt', 'did', 'githubLogin', 'operatorAddressAbt', 'operatorAddressEvm'];

beforeAll(() => {
  vi.stubEnv('FREEAGENTS_PLATFORM_SEED', 'f'.repeat(64));
});
afterAll(() => {
  vi.unstubAllEnvs();
});

let server: Server | null = null;
afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

interface Rig {
  readonly baseUrl: string;
  readonly accounts: AccountRepository;
  readonly jobs: MemoryJobRepository;
  // The Authorization header of a GitHub session for the given login.
  readonly signInAs: (login: string) => Promise<Record<string, string>>;
}

async function startRig(accounts: AccountRepository = new MemoryAccountRepository()): Promise<Rig> {
  const jobs = new MemoryJobRepository();
  // One adapter per login: the fake GitHub answers with a fixed user.
  const adapters = new Map<string, ReturnType<typeof createSessionAdapter>>();
  const adapterFor = (login: string): ReturnType<typeof createSessionAdapter> => {
    let adapter = adapters.get(login);
    if (adapter === undefined) {
      adapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login, id: 4242 }) });
      adapters.set(login, adapter);
    }
    return adapter;
  };
  // createApp takes one session adapter, so this one dispatches by token
  // to the adapter that minted it.
  const tokenOwner = new Map<string, string>();
  const dispatching = {
    beginGitHubOAuth: () => adapterFor('any').beginGitHubOAuth(),
    completeGitHubOAuth: () => Promise.resolve(null),
    getSession: async (token: string) => {
      const login = tokenOwner.get(token);
      return login === undefined ? null : adapterFor(login).getSession(token);
    },
  } as unknown as Parameters<typeof createApp>[11];
  const app = createApp(
    accounts,
    new MemoryAgentRepository(),
    undefined,
    undefined,
    jobs,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    dispatching,
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    accounts,
    jobs,
    signInAs: async (login: string) => {
      const token = await mintSessionToken(adapterFor(login));
      tokenOwner.set(token, login);
      return { authorization: ['Bearer', token].join(' ') };
    },
  };
}

async function get(rig: Rig, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${rig.baseUrl}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// A merged job for a buyer DID, so a conduct answer has something to count.
async function mergedJobFor(rig: Rig, id: string, buyerDid: string): Promise<void> {
  const job = createJob({ id, buyerDid, agentDid: 'did:abt:zNSomeAgent', repository: 'buyer/target-repo', brief: 'Fix it' }, new Date());
  await rig.jobs.create({ ...job, status: 'completed' });
}

describe('a login stored before proof is required does not act as a login (FIX-B62b)', () => {
  it('(a) a GitHub session for the login lands in its own account, never the stranger row that holds it unproved', async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: STRANGER_DID, unprovedGithubLogin: 'victim-login' });
    const rig = await startRig(accounts);
    const victimDid = (await createIdentityAdapter().createOperatorDid('victim-login')).did;

    const me = await get(rig, '/accounts/me', await rig.signInAs('victim-login'));

    expect(me.status).toBe(200);
    expect(me.body.did).toBe(victimDid);
    expect(me.body.did).not.toBe(STRANGER_DID);
    // Read back: the victim's own row now exists and holds the proved login.
    expect((await accounts.findByDid(victimDid))?.githubLogin).toBe('victim-login');
    // The stranger's row is exactly as it was.
    const stranger = await accounts.findByDid(STRANGER_DID);
    expect(stranger?.unprovedGithubLogin).toBe('victim-login');
    expect(stranger?.githubLogin).toBeNull();
  });

  it('(b) the conduct route answers keyed false until the login is proved, then only the person own jobs', async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: STRANGER_DID, unprovedGithubLogin: 'victim-login' });
    const rig = await startRig(accounts);
    await mergedJobFor(rig, 'job-stranger-1', STRANGER_DID);
    await mergedJobFor(rig, 'job-stranger-2', STRANGER_DID);

    // The seed took: the stranger's row holds the text unproved, under no proved login.
    expect((await accounts.findByDid(STRANGER_DID))?.unprovedGithubLogin).toBe('victim-login');
    const before = await get(rig, '/buyers/victim-login/conduct');
    expect(before.body).toEqual({ githubLogin: 'victim-login', keyed: false });

    await get(rig, '/accounts/me', await rig.signInAs('victim-login'));

    const after = await get(rig, '/buyers/victim-login/conduct');
    expect(after.body.keyed).toBe(true);
    expect((after.body.counts as Record<string, unknown>).merged).toBe(0);
    expect((after.body.counts as Record<string, unknown>).confirmed).toBe(0);
    // The stranger's history is still theirs, under no login at all.
    expect((await rig.accounts.findByDid(STRANGER_DID))?.githubLogin).toBeNull();
  });

  it('(c) the row sign-in itself made is re-proved at the next sign-in, and its jobs stay on it', async () => {
    const realDid = (await createIdentityAdapter().createOperatorDid('real-user')).did;
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: realDid, unprovedGithubLogin: 'real-user' });
    const rig = await startRig(accounts);
    await mergedJobFor(rig, 'job-real-1', realDid);

    const me = await get(rig, '/accounts/me', await rig.signInAs('real-user'));

    expect(me.body.did).toBe(realDid);
    const row = await accounts.findByDid(realDid);
    expect(row?.githubLogin).toBe('real-user');
    expect(row?.unprovedGithubLogin).toBeNull();
    const conduct = await get(rig, '/buyers/real-user/conduct');
    expect(conduct.body.keyed).toBe(true);
    expect((conduct.body.counts as Record<string, unknown>).merged).toBe(1);
    expect(await rig.jobs.findById('job-real-1')).not.toBeNull();
  });

  it('a storage fault while re-proving answers 503, not a session that acts as somebody else', async () => {
    const realDid = (await createIdentityAdapter().createOperatorDid('fault-user')).did;
    const inner = new MemoryAccountRepository();
    await inner.register({ did: realDid, unprovedGithubLogin: 'fault-user' });
    const faulty = Object.create(inner) as AccountRepository;
    (faulty as { promoteUnprovedGithubLogin: AccountRepository['promoteUnprovedGithubLogin'] }).promoteUnprovedGithubLogin = () =>
      Promise.reject(new AccountAlreadyExistsError(realDid));
    const rig = await startRig(faulty);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const me = await get(rig, '/accounts/me', await rig.signInAs('fault-user'));

    expect(me.status).toBe(503);
    expect((await inner.findByDid(realDid))?.githubLogin).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('promoteUnprovedGithubLogin, memory driver (FIX-B62b d)', () => {
  const DID = 'did:abt:zNPromoteRow';

  async function seeded(): Promise<MemoryAccountRepository> {
    const repo = new MemoryAccountRepository();
    await repo.register({ did: DID, unprovedGithubLogin: 'Some-Login' });
    return repo;
  }

  it('refuses a different DID and changes nothing', async () => {
    const repo = await seeded();
    expect(await repo.promoteUnprovedGithubLogin('did:abt:zNSomebodyElse', 'Some-Login')).toBeNull();
    const row = await repo.findByDid(DID);
    expect(row?.githubLogin).toBeNull();
    expect(row?.unprovedGithubLogin).toBe('Some-Login');
  });

  it('refuses a different login and changes nothing', async () => {
    const repo = await seeded();
    expect(await repo.promoteUnprovedGithubLogin(DID, 'other-login')).toBeNull();
    const row = await repo.findByDid(DID);
    expect(row?.githubLogin).toBeNull();
    expect(row?.unprovedGithubLogin).toBe('Some-Login');
  });

  it('refuses when githubLogin is already set and changes nothing', async () => {
    const repo = new MemoryAccountRepository();
    await repo.register({ did: DID, githubLogin: 'some-login', unprovedGithubLogin: 'some-login' });
    expect(await repo.promoteUnprovedGithubLogin(DID, 'some-login')).toBeNull();
    const row = await repo.findByDid(DID);
    expect(row?.githubLogin).toBe('some-login');
    expect(row?.unprovedGithubLogin).toBe('some-login');
  });

  it('refuses when unprovedGithubLogin is null and changes nothing', async () => {
    const repo = new MemoryAccountRepository();
    await repo.register({ did: DID });
    expect(await repo.promoteUnprovedGithubLogin(DID, 'some-login')).toBeNull();
    const row = await repo.findByDid(DID);
    expect(row?.githubLogin).toBeNull();
    expect(row?.unprovedGithubLogin).toBeNull();
  });

  it('refuses to put a proved login on a second row, throws, and changes neither row', async () => {
    const repo = new MemoryAccountRepository();
    await repo.register({ did: 'did:abt:zNHoldsProvedLogin', githubLogin: 'x' });
    await repo.register({ did: DID, unprovedGithubLogin: 'x' });
    await expect(repo.promoteUnprovedGithubLogin(DID, 'x')).rejects.toBeInstanceOf(AccountAlreadyExistsError);
    const holder = await repo.findByDid('did:abt:zNHoldsProvedLogin');
    expect(holder?.githubLogin).toBe('x');
    expect(holder?.unprovedGithubLogin).toBeNull();
    const legacy = await repo.findByDid(DID);
    expect(legacy?.githubLogin).toBeNull();
    expect(legacy?.unprovedGithubLogin).toBe('x');
    expect((await repo.findByGithubLogin('x'))?.did).toBe('did:abt:zNHoldsProvedLogin');
  });

  it('promotes a login that differs only in case, storing the spelling passed', async () => {
    const repo = await seeded();
    const promoted = await repo.promoteUnprovedGithubLogin(DID, 'some-LOGIN');
    expect(promoted?.githubLogin).toBe('some-LOGIN');
    expect(promoted?.unprovedGithubLogin).toBeNull();
    const row = await repo.findByDid(DID);
    expect(row?.githubLogin).toBe('some-LOGIN');
    expect(row?.unprovedGithubLogin).toBeNull();
    expect((await repo.findByGithubLogin('some-LOGIN'))?.did).toBe(DID);
  });
});

describe('the public shape never carries the unproved login (FIX-B62b e)', () => {
  it('GET /accounts/:did answers the five public keys, githubLogin null, and the text appears nowhere', async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: STRANGER_DID, unprovedGithubLogin: 'victim-login' });
    const rig = await startRig(accounts);

    expect((await accounts.findByDid(STRANGER_DID))?.unprovedGithubLogin).toBe('victim-login');
    const res = await get(rig, `/accounts/${STRANGER_DID}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(PUBLIC_KEYS);
    expect(res.body.githubLogin).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('victim-login');
    expect(JSON.stringify(res.body)).not.toContain('unprovedGithubLogin');
  });

  it('POST /accounts answers the five public keys and no unprovedGithubLogin key', async () => {
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: STRANGER_DID, unprovedGithubLogin: 'victim-login' });
    const rig = await startRig(accounts);

    const res = await fetch(`${rig.baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:zNFreshRegistration' }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS);
    expect(JSON.stringify(body)).not.toContain('unprovedGithubLogin');
    // A caller who sends the legacy field gets it dropped: no route writes it.
    const sneaky = await fetch(`${rig.baseUrl}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: 'did:abt:zNSneakyRegistration', unprovedGithubLogin: 'victim-login' }),
    });
    expect(sneaky.status).toBe(201);
    expect((await accounts.findByDid('did:abt:zNSneakyRegistration'))?.unprovedGithubLogin).toBeNull();
  });

  it('GET /accounts/me shows the account itself no unprovedGithubLogin key either', async () => {
    const realDid = (await createIdentityAdapter().createOperatorDid('me-user')).did;
    const accounts = new MemoryAccountRepository();
    await accounts.register({ did: realDid, unprovedGithubLogin: 'me-user' });
    const rig = await startRig(accounts);

    const me = await get(rig, '/accounts/me', await rig.signInAs('me-user'));

    expect(Object.keys(me.body).sort()).toEqual([...PUBLIC_KEYS, 'passkeySubject'].sort());
    expect(JSON.stringify(me.body)).not.toContain('unprovedGithubLogin');
  });
});
