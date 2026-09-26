-- HT1 Part A2 (ruling, 2026-09-25): the shared requestId a multi-agent
-- brief writes across each sibling job. Nullable, no backfill needed:
-- "not set" already means "this job was opened for one agent alone", the
-- exact meaning every existing row already carries.

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "requestId" TEXT;

-- CreateIndex
CREATE INDEX "Job_requestId_idx" ON "Job"("requestId");
