-- P6: the redo at staged, the cited close, and deemed completion credential
-- (design record, 2026-09-01, rows 2, 3 and 4). Two new JobStatus members
-- and the fields the redo mechanic and the cited close each write.

-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE 'redo_requested';
ALTER TYPE "JobStatus" ADD VALUE 'cited_closed';

-- AlterTable: the redo mechanic (design record row 2). redoUsedCount is
-- compared against redoAllowance and never decremented back down.
ALTER TABLE "Job" ADD COLUMN "redoUsedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "redoRequestedCriterionIndex" INTEGER;
ALTER TABLE "Job" ADD COLUMN "redoRequestedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN "redoRefusedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN "stagedLapseExtensionDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: the cited close (design record row 4). citedCloseAuthorDid
-- is always the job's own buyerDid, never a caller-supplied value.
ALTER TABLE "Job" ADD COLUMN "citedCloseCriterionIndex" INTEGER;
ALTER TABLE "Job" ADD COLUMN "citedCloseReasonText" TEXT;
ALTER TABLE "Job" ADD COLUMN "citedCloseAuthorDid" TEXT;
ALTER TABLE "Job" ADD COLUMN "citedCloseAt" TIMESTAMP(3);

-- AlterTable: the instant deemCompleted actually fired (design record row
-- 3), the fact the deemed-completion credential needs.
ALTER TABLE "Job" ADD COLUMN "deemedCompletedAt" TIMESTAMP(3);

-- P6 (design record, 2026-09-01, row 2): a redo produces a NEW
-- attestation record beside any earlier one, never an edit of it. The
-- one-attestation-per-job constraint from P5 widens to one-per-sequence:
-- drop the old unique index on jobId alone, add sequence, and constrain
-- the pair instead.
DROP INDEX "Attestation_jobId_key";
ALTER TABLE "Attestation" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Attestation" ALTER COLUMN "sequence" DROP DEFAULT;
CREATE UNIQUE INDEX "Attestation_jobId_sequence_key" ON "Attestation"("jobId", "sequence");
CREATE INDEX "Attestation_jobId_idx" ON "Attestation"("jobId");

