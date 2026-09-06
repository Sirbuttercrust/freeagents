-- P2: durable DID Connect session storage (invariant 12, scope item 5).

-- CreateTable
CREATE TABLE "DidConnectSession" (
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DidConnectSession_pkey" PRIMARY KEY ("token")
);
