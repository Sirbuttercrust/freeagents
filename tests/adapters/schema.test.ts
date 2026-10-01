// R-35 lap B: pins the Credential foreign key repoint (prisma/schema.prisma)
// as text, since the implement seat cannot run `prisma generate` and neither
// harness/ci.py nor harness/ci.py --quick validates the schema any other
// way. Without this, the fix to the dangling CompletedJob foreign key would
// be unvalidated by anything the factory can execute.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaPath = new URL('../../prisma/schema.prisma', import.meta.url);
const schema = readFileSync(schemaPath, 'utf8');

// Slice the file between `model X {` and the next `}` so an unrelated later
// edit elsewhere in the schema cannot flip this test by accident.
function modelBody(modelName: string): string {
  const start = schema.indexOf(`model ${modelName} {`);
  if (start === -1) {
    throw new Error(`model ${modelName} not found in schema.prisma`);
  }
  const bodyStart = schema.indexOf('{', start) + 1;
  const bodyEnd = schema.indexOf('\n}', bodyStart);
  return schema.slice(bodyStart, bodyEnd);
}

describe('prisma/schema.prisma, the Credential foreign key repoint (R-35 lap B)', () => {
  it("Credential's relation targets Job, not CompletedJob", () => {
    const credential = modelBody('Credential');
    expect(credential).toMatch(/completedJob\s+Job\s+@relation\(fields:\s*\[completedJobId\],\s*references:\s*\[id\]/);
    expect(credential).not.toMatch(/completedJob\s+CompletedJob\s+@relation/);
  });

  it('completedJobId is still @unique', () => {
    const credential = modelBody('Credential');
    expect(credential).toMatch(/completedJobId\s+String\s+@unique/);
  });

  it('CompletedJob no longer declares a Credential field', () => {
    const completedJob = modelBody('CompletedJob');
    expect(completedJob).not.toMatch(/\bCredential\b/);
  });

  it('Job declares exactly one Credential back-relation, as the optional singular form, not a list', () => {
    const job = modelBody('Job');
    const matches = job.match(/^\s*\w+\s+Credential\??\s*$/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/Credential\?\s*$/);
    expect(matches[0]).not.toMatch(/Credential\[\]/);
  });
});

describe('prisma/schema.prisma, the settlement fields (R-26, ENT-9)', () => {
  it('Settlement declares the four money/state columns the issue asks for', () => {
    const settlement = modelBody('Settlement');
    expect(settlement).toMatch(/amount\s+Decimal\?/);
    expect(settlement).toMatch(/currency\s+String\?/);
    expect(settlement).toMatch(/platformFee\s+Decimal\?/);
    expect(settlement).toMatch(/state\s+SettlementState/);
  });

  it('all three money columns are optional: nothing in v1 requires a value', () => {
    const settlement = modelBody('Settlement');
    expect(settlement).not.toMatch(/amount\s+Decimal[^?]/);
    expect(settlement).not.toMatch(/currency\s+String[^?]/);
    expect(settlement).not.toMatch(/platformFee\s+Decimal[^?]/);
  });

  it('jobId is unique: one settlement per job', () => {
    const settlement = modelBody('Settlement');
    expect(settlement).toMatch(/jobId\s+String\s+@unique/);
  });

  it('Job declares exactly one Settlement back-relation, as the optional singular form, not a list', () => {
    const job = modelBody('Job');
    const matches = job.match(/^\s*\w+\s+Settlement\??\s*$/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/Settlement\?\s*$/);
    expect(matches[0]).not.toMatch(/Settlement\[\]/);
  });
});

describe('prisma/schema.prisma, the compromise report (R-16, ENT-8.4)', () => {
  it('CompromiseReport declares key, since and reportedAt', () => {
    const compromiseReport = modelBody('CompromiseReport');
    expect(compromiseReport).toMatch(/key\s+String/);
    expect(compromiseReport).toMatch(/since\s+DateTime/);
    expect(compromiseReport).toMatch(/reportedAt\s+DateTime\s+@default\(now\(\)\)/);
  });

  it('CompromiseReport relates to Agent on agentDid referencing did', () => {
    const compromiseReport = modelBody('CompromiseReport');
    expect(compromiseReport).toMatch(
      /agent\s+Agent\s+@relation\(fields:\s*\[agentDid\],\s*references:\s*\[did\]/,
    );
  });

  it('Agent declares exactly one CompromiseReport back-relation, as the list form, not the optional singular', () => {
    const agent = modelBody('Agent');
    const matches = agent.match(/^\s*\w+\s+CompromiseReport(\[\]|\?)\s*$/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/CompromiseReport\[\]\s*$/);
    expect(matches[0]).not.toMatch(/CompromiseReport\?\s*$/);
  });

  it('declares no update or delete-oriented column: append-only is a property of the schema', () => {
    const compromiseReport = modelBody('CompromiseReport');
    expect(compromiseReport).not.toMatch(/deletedAt|revokedAt|withdrawnAt/);
  });
});

describe('prisma/schema.prisma, the review model (R-22, ENT-10, issue 29)', () => {
  it("Review's relation targets Job, not CompletedJob (same repoint as Credential, R-35 lap B)", () => {
    const review = modelBody('Review');
    expect(review).toMatch(/completedJob\s+Job\s+@relation\(fields:\s*\[completedJobId\],\s*references:\s*\[id\]/);
    expect(review).not.toMatch(/completedJob\s+CompletedJob\s+@relation/);
  });

  it('completedJobId is @unique: one review per completed job', () => {
    const review = modelBody('Review');
    expect(review).toMatch(/completedJobId\s+String\s+@unique/);
  });

  it('declares authorDid, agentDid and text, and no rating or score column anywhere (ENT-10.2)', () => {
    const review = modelBody('Review');
    expect(review).toMatch(/authorDid\s+String/);
    expect(review).toMatch(/agentDid\s+String/);
    expect(review).toMatch(/text\s+String/);
    expect(review).not.toMatch(/rating|score|stars?\b/i);
  });

  it('Job declares exactly one Review back-relation, as the optional singular form, not a list', () => {
    const job = modelBody('Job');
    const matches = job.match(/^\s*\w+\s+Review\??\s*$/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/Review\?\s*$/);
    expect(matches[0]).not.toMatch(/Review\[\]/);
  });
});

describe('prisma/schema.prisma, the Account model (R-39 completion, ENT-1.4)', () => {
  // P8d: githubLogin is now nullable (a passkey-only provisioned account
  // has no GitHub identity), but @unique still holds: a session can
  // resolve to at most one account through it.
  it('githubLogin is @unique: a session can resolve to at most one account', () => {
    const account = modelBody('Account');
    expect(account).toMatch(/githubLogin\s+String\?\s+@unique/);
  });

  it('passkeySubject is @unique and nullable: a passkey session can resolve to at most one account', () => {
    const account = modelBody('Account');
    expect(account).toMatch(/passkeySubject\s+String\?\s+@unique/);
  });
});

// S3 (this card, schema-change-without-migration): the same pinning
// pattern as the S5+S6 block above, against the operatorAddressEvm
// column this card's schema change adds. Without a migration shipped in
// the same commit, PrismaAccountRepository.setOperatorAddressEvm's
// update() call throws on any deployed database because the column
// never exists there.
describe('prisma/migrations, Account.operatorAddressEvm is actually migrated (S3)', () => {
  const migrationsDirS3 = new URL('../../prisma/migrations/', import.meta.url);

  function allMigrationSqlS3(): string {
    const dir = fileURLToPath(migrationsDirS3);
    if (!existsSync(dir)) return '';
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
  }

  it('a migration adds Account.operatorAddressEvm', () => {
    const sql = allMigrationSqlS3();
    expect(sql).toMatch(/ALTER TABLE\s+"Account"\s+ADD COLUMN\s+"operatorAddressEvm"\s+TEXT/);
  });

  it('the schema declares operatorAddressEvm as nullable, with no default', () => {
    const account = modelBody('Account');
    expect(account).toMatch(/operatorAddressEvm\s+String\?\s*$/m);
    expect(account).not.toMatch(/operatorAddressEvm[^\n]*@default/);
  });
});

// The mutation proof the
// card requires ("drop the unique constraint, a test goes red") must hold
// against the actual applied migration, not only against schema.prisma's
// text -- a schema whose model declares @unique but whose migration never
// shipped the constraint would pass every test above and still be
// unenforced on a real database. This reads the migration SQL Postgres
// would actually run.
describe('prisma/migrations, the Account unique constraints are actually migrated (R-39 completion)', () => {
  const migrationsDir = new URL('../../prisma/migrations/', import.meta.url);

  function allMigrationSql(): string {
    const dir = fileURLToPath(migrationsDir);
    if (!existsSync(dir)) return '';
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
  }

  it('at least one migration exists under prisma/migrations', () => {
    const dir = fileURLToPath(migrationsDir);
    expect(existsSync(dir), 'prisma/migrations does not exist: the schema unique constraints are undeployed').toBe(true);
    const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
    expect(entries.length, 'prisma/migrations exists but contains no migration directories').toBeGreaterThan(0);
  });

  it('a migration creates a unique index on Account.githubLogin', () => {
    const sql = allMigrationSql();
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*"Account"\("githubLogin"\)/);
  });

  it('a migration creates a unique index on Account.passkeySubject', () => {
    const sql = allMigrationSql();
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*"Account"\("passkeySubject"\)/);
  });
});

// ObservedSettlement
// was added to schema.prisma with no migration, so PrismaSettlementRepository's
// upsert/findUnique calls throw on any deployed database because the table
// never exists there. This pins the migration the same way the Account block
// above pins its two unique indexes: against the SQL Postgres would actually
// run, not against schema.prisma's text.
describe('prisma/migrations, the ObservedSettlement table is actually migrated', () => {
  const migrationsDir = new URL('../../prisma/migrations/', import.meta.url);

  function allMigrationSql(): string {
    const dir = fileURLToPath(migrationsDir);
    if (!existsSync(dir)) return '';
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
  }

  it('a migration creates the ObservedSettlement table', () => {
    const sql = allMigrationSql();
    expect(sql).toMatch(/CREATE TABLE\s+"ObservedSettlement"/);
  });

  it('a migration creates a unique index on ObservedSettlement(jobId, leg)', () => {
    const sql = allMigrationSql();
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*"ObservedSettlement"\("jobId",\s*"leg"\)/);
  });
});

// S5+S6 (this card, schema-change-without-migration): the same pinning
// pattern as the two describe blocks above, against the SignatureSpend
// table this card's schema change adds. Without a migration shipped in the
// same commit, PrismaSignatureSpendStorage's findUnique/create calls would
// throw on any deployed database because the table never exists there.
describe('prisma/migrations, the SignatureSpend table is actually migrated (S5+S6)', () => {
  const migrationsDir = new URL('../../prisma/migrations/', import.meta.url);

  function allMigrationSql(): string {
    const dir = fileURLToPath(migrationsDir);
    if (!existsSync(dir)) return '';
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
  }

  it('a migration creates the SignatureSpend table', () => {
    const sql = allMigrationSql();
    expect(sql).toMatch(/CREATE TABLE\s+"SignatureSpend"/);
  });

  it('a migration primary-keys SignatureSpend on (keyid, signatureHash)', () => {
    const sql = allMigrationSql();
    expect(sql).toMatch(/PRIMARY KEY \("keyid","signatureHash"\)/);
  });
});

// P8c (this card, schema-change-without-migration): the same pinning
// pattern as the S3 block above, against the operatorAddressAbt column
// this card's schema change adds. Without a migration shipped in the
// same commit, PrismaAccountRepository.setOperatorAddressAbt's update()
// call throws on any deployed database because the column never exists
// there.
describe('prisma/migrations, Account.operatorAddressAbt is actually migrated (P8c)', () => {
  const migrationsDirP8c = new URL('../../prisma/migrations/', import.meta.url);

  function allMigrationSqlP8c(): string {
    const dir = fileURLToPath(migrationsDirP8c);
    if (!existsSync(dir)) return '';
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
  }

  it('a migration adds Account.operatorAddressAbt', () => {
    const sql = allMigrationSqlP8c();
    expect(sql).toMatch(/ALTER TABLE\s+"Account"\s+ADD COLUMN\s+"operatorAddressAbt"\s+TEXT/);
  });

  it('the schema declares operatorAddressAbt as nullable, with no default', () => {
    const account = modelBody('Account');
    expect(account).toMatch(/operatorAddressAbt\s+String\?\s*$/m);
    expect(account).not.toMatch(/operatorAddressAbt[^\n]*@default/);
  });

  // Scope item 5 (backfill): every current Account's DID suffix is its
  // correct ABT address, because every current Account was created by
  // someone holding that DID. This pins that the migration actually
  // WRITES the backfill (mutation proof 4: remove it, this test goes
  // red), not merely that the column exists.
  it('the same migration backfills operatorAddressAbt from the DID suffix, not merely adding the column', () => {
    const sql = allMigrationSqlP8c();
    expect(sql).toMatch(/UPDATE\s+"Account"[\s\S]*SET\s+"operatorAddressAbt"/i);
  });
});

// P8d (this card, schema-change-without-migration): Account.githubLogin
// becomes nullable, so a passkey-only account never invents a synthetic
// GitHub login just to satisfy a NOT NULL column. No backfill: every
// existing row already carries a real login, and the scope line says none
// may be written for this change.
describe('prisma/migrations, Account.githubLogin is nullable (P8d)', () => {
  const migrationsDirP8d = new URL('../../prisma/migrations/', import.meta.url);

  function allMigrationSqlP8d(): string {
    const dir = fileURLToPath(migrationsDirP8d);
    if (!existsSync(dir)) return '';
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
  }

  it('a migration drops the NOT NULL constraint on Account.githubLogin', () => {
    const sql = allMigrationSqlP8d();
    expect(sql).toMatch(/ALTER TABLE\s+"Account"\s+ALTER COLUMN\s+"githubLogin"\s+DROP NOT NULL/i);
  });

  it('the schema declares githubLogin as nullable', () => {
    const account = modelBody('Account');
    expect(account).toMatch(/githubLogin\s+String\?\s+@unique/);
  });
});

// G1 (ENT-5.1 ruling, 2026-09-23): the two-path account
// proof model has no state between "unverified" and "verified" -- a
// binding is either proved through one whole path (session or gist) or it
// is not. `pending` was the direction-one-alone state the old bidirectional
// model produced; nothing in src writes it any more (the route that once
// did was removed in this same change), so it is dead surface the schema
// and the domain type should not still offer.
describe('prisma/schema.prisma, ProofStatus drops the dead pending state (G1, ENT-5.1)', () => {
  const migrationsDirG1 = new URL('../../prisma/migrations/', import.meta.url);

  function allMigrationSqlG1(): string {
    const dir = fileURLToPath(migrationsDirG1);
    if (!existsSync(dir)) return '';
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
  }

  it('the schema enum no longer declares pending', () => {
    const start = schema.indexOf('enum ProofStatus {');
    const end = schema.indexOf('}', start);
    const body = schema.slice(start, end);
    expect(body).not.toMatch(/\bpending\b/);
    expect(body).toMatch(/\bunverified\b/);
    expect(body).toMatch(/\bverified\b/);
  });

  it('a migration narrows the live ProofStatus enum to unverified/verified, dropping any pending row to unverified first', () => {
    const sql = allMigrationSqlG1();
    // Postgres cannot DROP VALUE from an enum type in place: the safe
    // shape is rename the old type out of the way, create the new one
    // with only the two remaining values, repoint the column (backfilling
    // any 'pending' row to 'unverified' on the way), then drop the old
    // type. All four must be present, in that order, or a live 'pending'
    // row on a real database blocks the column swap.
    expect(sql).toMatch(/ALTER TYPE\s+"ProofStatus"\s+RENAME TO\s+"ProofStatus_old"/i);
    expect(sql).toMatch(/CREATE TYPE\s+"ProofStatus"\s+AS ENUM\s*\(\s*'unverified',\s*'verified'\s*\)/);
    expect(sql).toMatch(/ALTER TABLE\s+"Agent"\s+ALTER COLUMN\s+"proofStatus"[\s\S]*?USING\s*\(CASE WHEN "proofStatus"::text = 'pending' THEN 'unverified' ELSE "proofStatus"::text END\)::"ProofStatus"/i);
    expect(sql).toMatch(/DROP TYPE\s+"ProofStatus_old"/i);
  });
});

// HT1 (ruling, 2026-09-25): the owner-first negotiation flag. Same pinning
// pattern as the AV1/S3/P8c blocks above, against the SQL Postgres would
// actually run for the negotiatesOnOwnersBehalf column this card adds.
describe('prisma/migrations, Agent.negotiatesOnOwnersBehalf is actually migrated (HT1)', () => {
  const migrationsDirHt1 = new URL('../../prisma/migrations/', import.meta.url);

  function allMigrationSqlHt1(): string {
    const dir = fileURLToPath(migrationsDirHt1);
    if (!existsSync(dir)) return '';
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
  }

  it('a migration adds Agent.negotiatesOnOwnersBehalf, boolean, defaulting false', () => {
    const sql = allMigrationSqlHt1();
    expect(sql).toMatch(/ALTER TABLE\s+"Agent"\s+ADD COLUMN\s+"negotiatesOnOwnersBehalf"\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+false/i);
  });

  it('the schema declares negotiatesOnOwnersBehalf as a non-null boolean defaulting false', () => {
    const agent = modelBody('Agent');
    expect(agent).toMatch(/negotiatesOnOwnersBehalf\s+Boolean\s+@default\(false\)/);
  });
});

// FIX-B61a: the stored passkey has its own table, keyed to the passkey name
// and not a relation to Account, and Account never carries key material.
describe('prisma, the PasskeyCredential table is declared and migrated (FIX-B61a)', () => {
  const migrations = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
  const sql = readdirSync(migrations, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(migrations, e.name, 'migration.sql')))
    .map((e) => readFileSync(join(migrations, e.name, 'migration.sql'), 'utf8'))
    .join('\n');

  it('declares the credential id as the key, the key as bytes, a counter, and no relation to Account', () => {
    const body = modelBody('PasskeyCredential');
    for (const line of [/\bid\s+String\s+@id\b/, /\bsubject\s+String\b/, /\bpublicKey\s+Bytes\b/, /\bcounter\s+Int\b/, /@@index\(\[subject\]\)/]) {
      expect(body).toMatch(line);
    }
    expect(body).not.toMatch(/@relation|\bAccount\b/);
    expect(modelBody('Account')).not.toMatch(/publicKey|credentialId|counter/i);
  });

  it('a migration creates the table with its primary key and its subject index', () => {
    expect(sql).toMatch(/CREATE TABLE\s+"PasskeyCredential"\s*\(/);
    expect(sql).toMatch(/"publicKey"\s+BYTEA\s+NOT NULL/);
    expect(sql).toMatch(/CONSTRAINT\s+"PasskeyCredential_pkey"\s+PRIMARY KEY\s*\("id"\)/);
    expect(sql).toMatch(/CREATE INDEX\s+"PasskeyCredential_subject_idx"\s+ON\s+"PasskeyCredential"\("subject"\)/);
  });
});

// FIX-B62b: a login stored before logins needed proof moves to its own
// column, and the migration that adds the column also moves the text and
// clears the proved column, so nothing is deleted and githubLogin holds
// proved logins only. Read as text, the same way the migrations above are.
describe('prisma, Account.unprovedGithubLogin is declared and migrated (FIX-B62b)', () => {
  const migrationsRoot = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
  const migrationName = readdirSync(migrationsRoot).find((name) => name.endsWith('_fix_b62b_unproved_github_login'));

  it('the schema declares unprovedGithubLogin as an optional String, not unique, with no default', () => {
    const line = modelBody('Account')
      .split('\n')
      .find((l) => /^\s*unprovedGithubLogin\b/.test(l));
    expect(line, 'Account declares no unprovedGithubLogin').toBeDefined();
    expect(line).toMatch(/unprovedGithubLogin\s+String\?\s*$/);
    expect(line).not.toMatch(/@unique/);
    expect(line).not.toMatch(/@default/);
    expect(modelBody('Account')).not.toMatch(/@@unique|@@index\(\[unprovedGithubLogin/);
  });

  it('a migration adds the column, then moves every stored login into it and clears githubLogin', () => {
    expect(migrationName, 'no migration named *_fix_b62b_unproved_github_login').toBeDefined();
    const sql = readFileSync(join(migrationsRoot, migrationName as string, 'migration.sql'), 'utf8');
    const add = sql.search(/ALTER TABLE\s+"Account"\s+ADD COLUMN\s+"unprovedGithubLogin"\s+TEXT\s*;/);
    const move = sql.search(
      /UPDATE\s+"Account"\s+SET\s+"unprovedGithubLogin"\s*=\s*"githubLogin"\s*,\s*"githubLogin"\s*=\s*NULL\s+WHERE\s+"githubLogin"\s+IS NOT NULL\s*;/,
    );
    expect(add).toBeGreaterThanOrEqual(0);
    expect(move).toBeGreaterThan(add);
    // Nothing is deleted: no row-removing statement anywhere in it.
    expect(sql).not.toMatch(/\b(DELETE|DROP|TRUN[C]ATE)\b/i);
  });
});

// FIX-SW4f (SW4-05): which message sends an upload is a stored fact.
describe('prisma/schema.prisma, Attachment.messageId (FIX-SW4f)', () => {
  it('the schema declares messageId as nullable, with no default', () => {
    const attachment = modelBody('Attachment');
    expect(attachment).toMatch(/messageId\s+String\?\s*$/m);
    expect(attachment).not.toMatch(/messageId[^\n]*@default/);
  });

  it('the schema indexes the two unsent-upload queries', () => {
    const attachment = modelBody('Attachment');
    expect(attachment).toMatch(/@@index\(\[uploaderDid, messageId, createdAt\]\)/);
    expect(attachment).toMatch(/@@index\(\[messageId, createdAt\]\)/);
  });

  it('a migration adds Attachment.messageId and both indexes', () => {
    const dir = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
    const sql = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'migration.sql'))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    expect(sql).toMatch(/ALTER TABLE\s+"Attachment"\s+ADD COLUMN\s+"messageId"\s+TEXT/);
    expect(sql).toMatch(/CREATE INDEX\s+"Attachment_uploaderDid_messageId_createdAt_idx"\s+ON\s+"Attachment"\("uploaderDid",\s*"messageId",\s*"createdAt"\)/);
    expect(sql).toMatch(/CREATE INDEX\s+"Attachment_messageId_createdAt_idx"\s+ON\s+"Attachment"\("messageId",\s*"createdAt"\)/);
  });
});

// The ABT-on-Ethereum rail: its rail value, the owner's payout column and
// its two settlement tables must be in the migration Postgres actually runs,
// not only in schema.prisma's text.
describe('prisma, the ABT-on-Ethereum rail value, payout column and settlement tables are actually migrated', () => {
  const migrationDir = new URL('../../prisma/migrations/20261001120000_abt_eth_rail/', import.meta.url);
  const sql = existsSync(fileURLToPath(migrationDir)) ? readFileSync(join(fileURLToPath(migrationDir), 'migration.sql'), 'utf8') : '';
  const code = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  function enumBody(name: string): string {
    const start = schema.indexOf(`enum ${name} {`);
    if (start === -1) throw new Error(`enum ${name} not found in schema.prisma`);
    const bodyStart = schema.indexOf('{', start) + 1;
    return schema.slice(bodyStart, schema.indexOf('\n}', bodyStart));
  }

  it('the Rail enum declares abt_eth beside abt and usdc', () => {
    expect(enumBody('Rail').split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['abt', 'usdc', 'abt_eth']);
  });

  it('the migration adds abt_eth to the Rail enum', () => {
    expect(code).toMatch(/ALTER TYPE\s+"Rail"\s+ADD VALUE\s+'abt_eth'\s*;/);
  });

  it("the migration names 'abt_eth' only in that one statement, because Postgres cannot use a new enum value in the transaction that adds it", () => {
    expect(code.match(/abt_eth/g)).toHaveLength(1);
  });

  it('the migration adds Account.operatorAddressAbtEth as plain nullable TEXT, with no default and no backfill', () => {
    expect(code).toMatch(/ALTER TABLE\s+"Account"\s+ADD COLUMN\s+"operatorAddressAbtEth"\s+TEXT\s*;/);
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\bINSERT\b/i);
    expect(code).not.toMatch(/operatorAddressAbtEth[^;]*DEFAULT/i);
  });

  it('the schema declares operatorAddressAbtEth as nullable, with no default', () => {
    const account = modelBody('Account');
    expect(account).toMatch(/operatorAddressAbtEth\s+String\?\s*$/m);
    expect(account).not.toMatch(/operatorAddressAbtEth[^\n]*@default/);
  });

  it('the migration creates the ABT-on-Ethereum spent-hash table keyed by hash alone, beside the USDC one', () => {
    expect(code).toMatch(/CREATE TABLE\s+"AbtEthSpentTransfer"/);
    expect(code).toMatch(/CONSTRAINT\s+"AbtEthSpentTransfer_pkey"\s+PRIMARY KEY\s+\("hash"\)/);
    expect(modelBody('AbtEthSpentTransfer')).toMatch(/hash\s+String\s+@id/);
  });

  it('the migration creates the ABT-on-Ethereum half-paid table with one row per job and leg', () => {
    expect(code).toMatch(/CREATE TABLE\s+"AbtEthHalfPaidSettlement"/);
    expect(code).toMatch(/CREATE UNIQUE INDEX\s+"AbtEthHalfPaidSettlement_jobId_leg_key"\s+ON\s+"AbtEthHalfPaidSettlement"\("jobId",\s*"leg"\)/);
    expect(modelBody('AbtEthHalfPaidSettlement')).toMatch(/@@unique\(\[jobId, leg\]\)/);
  });

  it('leaves the USDC settlement tables as they were: no statement touches them', () => {
    expect(code).not.toMatch(/"UsdcSpentTransfer"/);
    expect(code).not.toMatch(/"UsdcHalfPaidSettlement"/);
  });
});

// The quoted ABT-on-Ethereum price, one row per checkout start. It must be
// in the migration Postgres actually runs, and it must not carry a unique key
// on (jobId, leg): two checkouts of one leg each keep the price they showed.
describe('prisma, the ABT-on-Ethereum quote lock table is a row per start and is actually migrated', () => {
  const migrationDir = new URL('../../prisma/migrations/20261001180000_abt_eth_quote_lock/', import.meta.url);
  const sql = existsSync(fileURLToPath(migrationDir)) ? readFileSync(join(fileURLToPath(migrationDir), 'migration.sql'), 'utf8') : '';
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement !== '');

  it('the model declares the ten columns and the (jobId, leg) index', () => {
    const lines = modelBody('AbtEthQuoteLock')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'))
      .map((line) => line.split(/\s+/));
    expect(lines).toEqual([
      ['id', 'String', '@id', '@default(cuid())'],
      ['jobId', 'String'],
      ['leg', 'String'],
      ['amountUsd', 'String'],
      ['usdPerToken', 'String'],
      ['rateUpdatedAt', 'DateTime?'],
      ['amountToken', 'String'],
      ['feeToken', 'String'],
      ['lockedAt', 'DateTime'],
      ['expiresAt', 'DateTime'],
      ['@@index([jobId,', 'leg])'],
    ]);
  });

  it('the model has no unique key on (jobId, leg)', () => {
    expect(modelBody('AbtEthQuoteLock')).not.toMatch(/@@unique|@unique/);
  });

  it('the migration creates the table with its primary key on id, then the (jobId, leg) index, and nothing else', () => {
    expect(statements).toEqual([
      'CREATE TABLE "AbtEthQuoteLock" ( "id" TEXT NOT NULL, "jobId" TEXT NOT NULL, "leg" TEXT NOT NULL, "amountUsd" TEXT NOT NULL, "usdPerToken" TEXT NOT NULL, "rateUpdatedAt" TIMESTAMP(3), "amountToken" TEXT NOT NULL, "feeToken" TEXT NOT NULL, "lockedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AbtEthQuoteLock_pkey" PRIMARY KEY ("id") )',
      'CREATE INDEX "AbtEthQuoteLock_jobId_leg_idx" ON "AbtEthQuoteLock"("jobId", "leg")',
    ]);
  });
});
