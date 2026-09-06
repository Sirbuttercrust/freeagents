-- P10: the observed settlement record (payment surface brief, scope item
-- 1). One row per (jobId, leg), written only once confirm() has observed
-- a receipt on chain. Rail reuses the existing "Rail" enum from
-- prisma/migrations/20260905160000_p1_agreement_price/migration.sql.

-- CreateTable
CREATE TABLE "ObservedSettlement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "rail" "Rail" NOT NULL,
    "hash" TEXT NOT NULL,
    "secondaryHash" TEXT,
    "operatorAddress" TEXT NOT NULL,
    "feeAddress" TEXT NOT NULL,
    "amountUsd" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservedSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ObservedSettlement_jobId_leg_key" ON "ObservedSettlement"("jobId", "leg");
