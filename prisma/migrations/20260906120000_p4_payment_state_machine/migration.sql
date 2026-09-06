-- P4: the payment state machine (staged, the two clocks, deposit gates
-- confirm and balance gates the pull request). Five new JobStatus members
-- and the two staging columns (design record, 2026-09-01).

-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE 'staged';
ALTER TYPE "JobStatus" ADD VALUE 'staged_declined';
ALTER TYPE "JobStatus" ADD VALUE 'closed_unpaid';
ALTER TYPE "JobStatus" ADD VALUE 'expired_unstaged';
ALTER TYPE "JobStatus" ADD VALUE 'deemed_completed';

-- AlterTable: the instant the agent staged the work and the commit SHA it
-- staged (confirmed -> staged). Both null until staged, written together
-- by stageWork.
ALTER TABLE "Job" ADD COLUMN "stagedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN "stagedCommit" TEXT;
