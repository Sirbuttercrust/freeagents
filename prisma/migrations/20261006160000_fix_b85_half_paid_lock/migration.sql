-- The ABT-on-Ethereum half-paid record names the quote lock its confirmed
-- transfer was checked against, so a later start and a later report finish
-- the payment at that lock's amounts. The column is nullable: a row written
-- before it reads as null, and no existing row is changed.

-- AlterTable
ALTER TABLE "AbtEthHalfPaidSettlement" ADD COLUMN "lockId" TEXT;
