-- P5: the attestation the platform publishes when a job reaches `staged`
-- (design record, 2026-09-01). One row per job, immutable once written.

-- CreateTable
CREATE TABLE "Attestation" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "signed" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attestation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attestation_jobId_key" ON "Attestation"("jobId");

-- AddForeignKey
ALTER TABLE "Attestation" ADD CONSTRAINT "Attestation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
