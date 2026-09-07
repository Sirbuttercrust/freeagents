-- P8d: Account.githubLogin becomes nullable. A passkey-only account,
-- provisioned automatically at first sign-in, has no GitHub identity at
-- all; a synthetic placeholder value would poison the unique column and
-- key GET /buyers/:githubLogin/conduct on fabricated data. No backfill:
-- every row that exists before this migration already carries a real
-- login, so nothing here needs to change value, only nullability.

-- AlterTable
ALTER TABLE "Account" ALTER COLUMN "githubLogin" DROP NOT NULL;
