-- B14a: the staging repository the platform creates per confirmed job
-- (owner/repo under the platform account), the base commit the platform
-- pinned when it created that repository, and the cleanup policy field
-- (recorded not built -- see src/domain/job.ts's own header comment).

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "stagingRepoOwner" TEXT,
ADD COLUMN "stagingRepoName" TEXT,
ADD COLUMN "baseCommit" TEXT,
ADD COLUMN "stagingRepoDeleteAfter" TIMESTAMP(3);
