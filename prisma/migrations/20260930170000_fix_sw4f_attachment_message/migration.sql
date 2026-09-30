-- AlterTable
-- FIX-SW4f (bugs.md SW4-05): which message sends an upload. Nullable, no
-- default and no backfill: a row stored before this migration keeps NULL and
-- nothing is moved, changed or deleted by it. The unsent-upload sweep never
-- removes a NULL row that a message carries; it records the message on the
-- row and keeps it.
ALTER TABLE "Attachment" ADD COLUMN "messageId" TEXT;

-- CreateIndex
-- Serves AttachmentRepository.listUnsentByUploader: WHERE "uploaderDid" = $1
-- AND "messageId" IS NULL AND "createdAt" >= $2. Two equality columns, then
-- the createdAt range, so the planner reads one contiguous index range.
CREATE INDEX "Attachment_uploaderDid_messageId_createdAt_idx" ON "Attachment"("uploaderDid", "messageId", "createdAt");

-- CreateIndex
-- Serves AttachmentRepository.listUnsentOlderThan: WHERE "messageId" IS NULL
-- AND "createdAt" < $1 ORDER BY "createdAt" ASC LIMIT $2. One equality
-- column, then the createdAt range in index order, so the LIMIT stops the
-- scan early and no sort is needed.
CREATE INDEX "Attachment_messageId_createdAt_idx" ON "Attachment"("messageId", "createdAt");
