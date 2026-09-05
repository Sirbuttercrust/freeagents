-- P1: the agreement carries a price (priceUsd, rail, deposit 25, redo 1).

-- CreateEnum
CREATE TYPE "Rail" AS ENUM ('abt', 'usdc');

-- AlterTable: Agent gets the optional floor (MAP.md, scope item 5).
ALTER TABLE "Agent" ADD COLUMN "floorPriceUsd" TEXT;

-- AlterTable: Job carries the agreed price (ENT-4.2), the rail, per-party
-- acceptance of the price line, and the fixed deposit/redo/window fields.
ALTER TABLE "Job" ADD COLUMN "priceUsd" TEXT;
ALTER TABLE "Job" ADD COLUMN "rail" "Rail";
ALTER TABLE "Job" ADD COLUMN "priceAcceptedByBuyer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Job" ADD COLUMN "priceAcceptedByAgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Job" ADD COLUMN "depositPercent" INTEGER NOT NULL DEFAULT 25;
ALTER TABLE "Job" ADD COLUMN "redoAllowance" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Job" ADD COLUMN "deliveryWindowDays" INTEGER;
