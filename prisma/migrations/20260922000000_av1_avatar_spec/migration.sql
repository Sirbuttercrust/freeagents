-- AV1 (ENT-2.3 ruling, 2026-09-22): the operator's stored avatar override.
-- Nullable, no default, mirroring P8c's operatorAddressAbt shape exactly:
-- an existing row has no override on record until its operator sets one
-- through PUT /agents/:agentDid/avatar, and every agent falls back to its
-- DID-derived default (src/domain/avatar-spec.ts's defaultAvatar) until
-- then. No backfill: unlike P8c's ABT address, there is no prior implicit
-- value to migrate forward here -- "no override" already means exactly
-- what a null column means.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "avatarSpec" JSONB;
