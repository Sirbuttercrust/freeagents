-- P7: the operator's two listing filters on buyer conduct (committee
-- synthesis row 7). Both nullable, both null by default: null means no
-- filter, and the platform sets no default.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "minBuyerMerges" INTEGER;
ALTER TABLE "Agent" ADD COLUMN "maxWalkedAfterConfirm" INTEGER;
