-- G1 (ENT-5.1 ruling, 2026-09-23): the two-path account proof model has no
-- state between "unverified" and "verified" -- a binding is either proved
-- through one whole path (session or gist) or it is not. `pending` was the
-- direction-one-alone state the old bidirectional model produced; nothing
-- in the application writes it any more (the route that once did was
-- removed in this same change).
--
-- Postgres cannot DROP VALUE from an enum type in place, so the column is
-- swapped onto a freshly-created type with only the two remaining values.
-- Any row still carrying the now-gone 'pending' value is backfilled to
-- 'unverified' as part of the same ALTER, so this is safe to run against a
-- live database no matter what a row currently holds.

-- RenameEnum (make room for the replacement)
ALTER TYPE "ProofStatus" RENAME TO "ProofStatus_old";

-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('unverified', 'verified');

-- AlterTable (repoint the column, backfilling any 'pending' row first)
ALTER TABLE "Agent"
  ALTER COLUMN "proofStatus" DROP DEFAULT,
  ALTER COLUMN "proofStatus" TYPE "ProofStatus"
    USING (CASE WHEN "proofStatus"::text = 'pending' THEN 'unverified' ELSE "proofStatus"::text END)::"ProofStatus",
  ALTER COLUMN "proofStatus" SET DEFAULT 'unverified';

-- DropEnum
DROP TYPE "ProofStatus_old";
