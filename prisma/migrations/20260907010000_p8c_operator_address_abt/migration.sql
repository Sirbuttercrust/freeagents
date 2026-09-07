-- P8c: the ABT address an Account is paid at (Anchor: Account.did must
-- stop silently doubling as a real ABT payout address). Nullable, no
-- default, mirroring S3's operatorAddressEvm exactly: an existing row has
-- no ABT address on record until its operator sets one through
-- PATCH /accounts/:did/operator-address, and an ABT payment for a job
-- hiring that account's agent refuses to start until it does.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "operatorAddressAbt" TEXT;

-- P8c backfill: every current Account's DID suffix is its correct ABT
-- address, because every current Account was created by someone holding
-- that DID (the same binding operatorAddressForJob used to derive on
-- every call, before this card gave the ABT rail a stored column of its
-- own). This is safe to run exactly once, here, because it is the only
-- place that binding was ever true: any account created AFTER this
-- migration goes through P8c's route instead, which never assumes a
-- DID's key holder is its payout address. Strips the "did:abt:" prefix
-- the same way src/domain/agent.ts's didSuffix does; a DID stored
-- without that prefix already is its own suffix and is copied as-is.
UPDATE "Account"
SET "operatorAddressAbt" = CASE
  WHEN "did" LIKE 'did:abt:%' THEN substring("did" FROM 9)
  ELSE "did"
END
WHERE "operatorAddressAbt" IS NULL;
