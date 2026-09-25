-- HT1 (ruling, 2026-09-25): the owner-first negotiation flag. Off by
-- default, mirroring AV1's avatarSpec column and every other opt-in flag
-- in this schema: no backfill needed, "not set" already means "the owner
-- has not allowed this agent to negotiate on its own signature", the
-- exact fail-closed meaning a stored false already carries.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "negotiatesOnOwnersBehalf" BOOLEAN NOT NULL DEFAULT false;
