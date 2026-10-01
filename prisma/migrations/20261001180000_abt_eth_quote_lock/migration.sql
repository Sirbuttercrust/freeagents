-- The ABT price a checkout of the ABT-on-Ethereum rail quoted and showed.
-- One row per start: there is no unique key on (jobId, leg), because two
-- checkouts of the same leg each keep the price they showed. It is a quoted
-- price, not a payment record. No existing row is touched.

-- CreateTable
CREATE TABLE "AbtEthQuoteLock" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "amountUsd" TEXT NOT NULL,
    "usdPerToken" TEXT NOT NULL,
    "rateUpdatedAt" TIMESTAMP(3),
    "amountToken" TEXT NOT NULL,
    "feeToken" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbtEthQuoteLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbtEthQuoteLock_jobId_leg_idx" ON "AbtEthQuoteLock"("jobId", "leg");
