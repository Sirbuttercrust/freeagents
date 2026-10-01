-- The data for the ABT-on-Ethereum payment rail: its rail value, its owner
-- payout address and its two settlement tables. The code that pays through
-- the rail is added by a later change.
--
-- Postgres will not let a statement use an enum value in the transaction
-- that adds it, and each migration runs in one transaction, so nothing in
-- this file names 'abt_eth' except the ALTER TYPE below. No row is
-- written, backfilled or changed.

-- AlterEnum
ALTER TYPE "Rail" ADD VALUE 'abt_eth';

-- AlterTable
-- The owner's ABT-on-Ethereum payout address. Nullable, no default and no
-- backfill: nothing copies the Arbitrum address (or any other network's
-- address) into it. An address is only meaningful on the network it was
-- entered for.
ALTER TABLE "Account" ADD COLUMN "operatorAddressAbtEth" TEXT;

-- The two settlement tables are added beside the USDC ones instead of
-- widening them with a rail column. A transaction hash is only unique
-- within one chain, so the Ethereum rail needs its own spent-hash record
-- (a hash that backed a USDC leg on Arbitrum must not block, or be
-- mistaken for, the same string on Ethereum), and a widened primary key on
-- the live USDC table would rewrite that table's key for no gain. Same
-- columns, same keys, own tables.

-- CreateTable
CREATE TABLE "AbtEthSpentTransfer" (
    "hash" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "role" "UsdcTransferRole" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbtEthSpentTransfer_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "AbtEthHalfPaidSettlement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "priceTxHash" TEXT NOT NULL,
    "priceStatus" "UsdcTransferStatus" NOT NULL,
    "feeTxHash" TEXT,
    "feeStatus" "UsdcTransferStatus" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbtEthHalfPaidSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbtEthSpentTransfer_jobId_leg_idx" ON "AbtEthSpentTransfer"("jobId", "leg");

-- CreateIndex
CREATE UNIQUE INDEX "AbtEthHalfPaidSettlement_jobId_leg_key" ON "AbtEthHalfPaidSettlement"("jobId", "leg");
