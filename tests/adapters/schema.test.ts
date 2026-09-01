// R-35 lap B: pins the Credential foreign key repoint (prisma/schema.prisma)
// as text, since the implement seat cannot run `prisma generate` and neither
// harness/ci.py nor harness/ci.py --quick validates the schema any other
// way. Without this, the fix to the dangling CompletedJob foreign key would
// be unvalidated by anything the factory can execute.
import { readFileSync } from 'node:fs';
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
