-- S3: the EVM address an Account is paid at on the USDC rail (Ruling 3).
-- Nullable, no default, no backfill: an existing row has no address on
-- record until its operator sets one through
-- PATCH /accounts/:did/operator-address, and a USDC payment for a job
-- hiring that account's agent refuses to start (409) until it does
-- (Ruling 5). On Account, not Agent: see prisma/schema.prisma's own
-- comment on the column for why.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "operatorAddressEvm" TEXT;
