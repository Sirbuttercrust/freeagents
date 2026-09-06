-- P3: the durable half-paid USDC settlement record (scope item 3).

-- CreateEnum
CREATE TYPE "UsdcTransferStatus" AS ENUM ('confirmed', 'not_confirmed', 'not_signed');

-- CreateTable
CREATE TABLE "UsdcHalfPaidSettlement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "priceTxHash" TEXT NOT NULL,
    "priceStatus" "UsdcTransferStatus" NOT NULL,
    "feeTxHash" TEXT,
    "feeStatus" "UsdcTransferStatus" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsdcHalfPaidSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsdcHalfPaidSettlement_jobId_leg_key" ON "UsdcHalfPaidSettlement"("jobId", "leg");
