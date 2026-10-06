-- A price transfer of the ABT-on-Ethereum rail that the network recorded after
-- its price hold and that was worth less than the agreed price when the
-- platform read it, or could not be priced. One row per price transfer, keyed
-- by its lower-case hash; the (jobId, leg) index is not unique, because a
-- second transfer for the same leg is another row. No existing row is touched.

-- CreateTable
CREATE TABLE "AbtEthShortPayment" (
    "priceTxHash" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "lockId" TEXT NOT NULL,
    "feeTxHash" TEXT,
    "amountToken" TEXT NOT NULL,
    "amountUsd" TEXT NOT NULL,
    "usdPerTokenAtRead" TEXT,
    "worthUsd" TEXT,
    "recordedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbtEthShortPayment_pkey" PRIMARY KEY ("priceTxHash")
);

-- CreateIndex
CREATE INDEX "AbtEthShortPayment_jobId_leg_idx" ON "AbtEthShortPayment"("jobId", "leg");
