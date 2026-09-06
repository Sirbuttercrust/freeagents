-- S1: bind a USDC settlement to the transfer it claims. Widens
-- UsdcTransferStatus with 'mismatched' (a landed transfer that paid the
-- wrong recipient, amount, token or chain) and adds the durable
-- spent-transfer record so one receipt cannot confirm more than one
-- settlement leg.

-- AlterEnum
ALTER TYPE "UsdcTransferStatus" ADD VALUE 'mismatched';

-- CreateEnum
CREATE TYPE "UsdcTransferRole" AS ENUM ('price', 'fee');

-- CreateTable
CREATE TABLE "UsdcSpentTransfer" (
    "hash" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "role" "UsdcTransferRole" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsdcSpentTransfer_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE INDEX "UsdcSpentTransfer_jobId_leg_idx" ON "UsdcSpentTransfer"("jobId", "leg");
