-- FIX-B43a (ruling, 2026-09-27): the agent's listing state. Boolean, not
-- nullable, defaulted true: every agent listed today stays listed, with
-- no backfill. Reversible through PUT /agents/:agentDid/listing, never a
-- delegation revoke.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "listed" BOOLEAN NOT NULL DEFAULT true;
