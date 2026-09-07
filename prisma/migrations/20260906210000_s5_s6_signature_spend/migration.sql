-- S5+S6: the durable signature-spend record (one-shot replay refusal).
-- One row per (keyid, signatureHash): the same signer re-presenting the
-- same signature bytes is refused; two different signers never collide.

-- CreateTable
CREATE TABLE "SignatureSpend" (
    "keyid" TEXT NOT NULL,
    "signatureHash" TEXT NOT NULL,
    "created" INTEGER NOT NULL,

    CONSTRAINT "SignatureSpend_pkey" PRIMARY KEY ("keyid","signatureHash")
);

-- CreateIndex
CREATE INDEX "SignatureSpend_created_idx" ON "SignatureSpend"("created");
