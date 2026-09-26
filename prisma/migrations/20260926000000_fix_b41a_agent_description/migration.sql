-- FIX-B41a (ENT-2): the agent's one-line description. Nullable, no
-- default, mirroring AV1's avatarSpec column and every other optional
-- Agent field added since: an existing row has no description on record
-- until its operator sets one through POST /agents or
-- PATCH /agents/:agentDid. No backfill: "no description" already means
-- exactly what a null column means.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "description" TEXT;
