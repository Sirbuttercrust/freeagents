-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('unverified', 'pending', 'verified');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('draft', 'proposed', 'confirmed', 'submitted', 'completed', 'declined', 'closed_unmerged', 'stale', 'withdrawn');

-- CreateEnum
CREATE TYPE "SettlementState" AS ENUM ('recorded_intent');

-- CreateTable
CREATE TABLE "Account" (
    "did" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "passkeySubject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("did")
);

-- CreateTable
CREATE TABLE "Agent" (
    "did" TEXT NOT NULL,
    "operatorDid" TEXT NOT NULL,
    "delegation" JSONB NOT NULL,
    "name" TEXT NOT NULL,
    "skills" TEXT[],
    "githubLogin" TEXT,
    "proofStatus" "ProofStatus" NOT NULL DEFAULT 'unverified',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("did")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "buyerDid" TEXT NOT NULL,
    "agentDid" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "briefHash" TEXT NOT NULL,
    "confirmedSpecHash" TEXT,
    "criteria" JSONB,
    "status" "JobStatus" NOT NULL DEFAULT 'proposed',
    "pullRequestUrl" TEXT,
    "mergeCommit" TEXT,
    "mergedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompletedJob" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "buyerDid" TEXT NOT NULL,
    "agentDid" TEXT NOT NULL,
    "mergeCommit" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompletedJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "completedJobId" TEXT NOT NULL,
    "subjectDid" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "repositoryPublic" BOOLEAN,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyRotation" (
    "id" TEXT NOT NULL,
    "agentDid" TEXT NOT NULL,
    "fromKey" TEXT NOT NULL,
    "toKey" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeyRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompromiseReport" (
    "id" TEXT NOT NULL,
    "agentDid" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompromiseReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "amount" DECIMAL(65,30),
    "currency" TEXT,
    "platformFee" DECIMAL(65,30),
    "state" "SettlementState" NOT NULL DEFAULT 'recorded_intent',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "completedJobId" TEXT NOT NULL,
    "authorDid" TEXT NOT NULL,
    "agentDid" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_githubLogin_key" ON "Account"("githubLogin");

-- CreateIndex
CREATE UNIQUE INDEX "Account_passkeySubject_key" ON "Account"("passkeySubject");

-- CreateIndex
CREATE INDEX "Agent_operatorDid_idx" ON "Agent"("operatorDid");

-- CreateIndex
CREATE INDEX "Agent_githubLogin_idx" ON "Agent"("githubLogin");

-- CreateIndex
CREATE INDEX "Job_agentDid_idx" ON "Job"("agentDid");

-- CreateIndex
CREATE INDEX "Job_buyerDid_idx" ON "Job"("buyerDid");

-- CreateIndex
CREATE UNIQUE INDEX "CompletedJob_jobId_key" ON "CompletedJob"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "CompletedJob_id_buyerDid_agentDid_key" ON "CompletedJob"("id", "buyerDid", "agentDid");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_completedJobId_key" ON "Credential"("completedJobId");

-- CreateIndex
CREATE INDEX "Credential_subjectDid_idx" ON "Credential"("subjectDid");

-- CreateIndex
CREATE INDEX "KeyRotation_agentDid_idx" ON "KeyRotation"("agentDid");

-- CreateIndex
CREATE INDEX "CompromiseReport_agentDid_idx" ON "CompromiseReport"("agentDid");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_jobId_key" ON "Settlement"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_completedJobId_key" ON "Review"("completedJobId");

-- CreateIndex
CREATE INDEX "Review_agentDid_idx" ON "Review"("agentDid");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_operatorDid_fkey" FOREIGN KEY ("operatorDid") REFERENCES "Account"("did") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_agentDid_fkey" FOREIGN KEY ("agentDid") REFERENCES "Agent"("did") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompletedJob" ADD CONSTRAINT "CompletedJob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_completedJobId_fkey" FOREIGN KEY ("completedJobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_subjectDid_fkey" FOREIGN KEY ("subjectDid") REFERENCES "Agent"("did") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyRotation" ADD CONSTRAINT "KeyRotation_agentDid_fkey" FOREIGN KEY ("agentDid") REFERENCES "Agent"("did") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompromiseReport" ADD CONSTRAINT "CompromiseReport_agentDid_fkey" FOREIGN KEY ("agentDid") REFERENCES "Agent"("did") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_completedJobId_fkey" FOREIGN KEY ("completedJobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

