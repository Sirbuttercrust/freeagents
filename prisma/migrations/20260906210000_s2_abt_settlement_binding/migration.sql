-- S2: bind an ABT settlement to the transaction it claims. Adds the
-- durable spent-transfer record so one ABT transaction cannot confirm
-- more than one job or leg, the same protection S1 shipped for the USDC
-- rail (UsdcSpentTransfer). No role column here: a single TransferV3Tx
-- carries both the operator and fee outputs in one broadcast.

-- CreateTable
CREATE TABLE "AbtSpentTransfer" (
    "hash" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbtSpentTransfer_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE INDEX "AbtSpentTransfer_jobId_leg_idx" ON "AbtSpentTransfer"("jobId", "leg");
