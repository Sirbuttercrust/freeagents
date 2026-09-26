-- HT1 Part B (2026-09-25): the hire thread, notifications, and message
-- attachments. See src/domain/message.ts, src/domain/notification.ts and
-- src/domain/attachment.ts for the shapes these tables back.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "notifyWebhookUrl" TEXT;

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "authorDid" TEXT,
    "authorParty" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "replyToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "editHistory" JSONB NOT NULL DEFAULT '[]',
    "reactionBuyer" TEXT,
    "reactionAgent" TEXT,
    "attachmentIds" TEXT[],
    "systemEvent" JSONB,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadReadState" (
    "jobId" TEXT NOT NULL,
    "party" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreadReadState_pkey" PRIMARY KEY ("jobId","party")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "accountDid" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "uploaderDid" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "accountDid" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_jobId_idx" ON "Message"("jobId");

-- CreateIndex
CREATE INDEX "Notification_accountDid_idx" ON "Notification"("accountDid");

-- CreateIndex
CREATE INDEX "Attachment_jobId_idx" ON "Attachment"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_accountDid_idx" ON "PushSubscription"("accountDid");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
