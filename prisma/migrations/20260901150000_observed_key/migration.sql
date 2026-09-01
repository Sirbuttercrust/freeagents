-- CreateTable
CREATE TABLE "ObservedKey" (
    "did" TEXT NOT NULL,
    "verificationMethod" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservedKey_pkey" PRIMARY KEY ("did")
);
