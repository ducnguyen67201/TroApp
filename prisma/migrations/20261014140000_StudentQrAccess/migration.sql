-- AlterTable
ALTER TABLE "user" ALTER COLUMN "email" DROP NOT NULL;

-- CreateTable
CREATE TABLE "StudentSchool" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rosterRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentSchool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAdmission" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "codeDigest" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentAdmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentDevice" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "credentialDigest" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentLearnerProfile" (
    "userId" TEXT NOT NULL,
    "schoolId" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'school-card',
    "externalId" TEXT NOT NULL,
    "rosterName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentLearnerProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "StudentLearnerSession" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "payloadDigest" TEXT NOT NULL,
    "credentialDigest" TEXT NOT NULL,
    "meetingId" UUID,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentLearnerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAccessUsage" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StudentAccessUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentRosterRecord" (
    "schoolId" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'school-card',
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "StudentRosterRecord_pkey" PRIMARY KEY ("schoolId","source","externalId")
);

-- CreateTable
CREATE TABLE "StudentRosterBatch" (
    "schoolId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "payloadDigest" TEXT NOT NULL,

    CONSTRAINT "StudentRosterBatch_pkey" PRIMARY KEY ("schoolId","revision","payloadDigest")
);

-- CreateTable
CREATE TABLE "StudentAccessAudit" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentAccessAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudentSchool_ownerId_key" ON "StudentSchool"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAdmission_codeDigest_key" ON "StudentAdmission"("codeDigest");

-- CreateIndex
CREATE INDEX "StudentAdmission_classId_revoked_idx" ON "StudentAdmission"("classId", "revoked");

-- CreateIndex
CREATE UNIQUE INDEX "StudentDevice_requestId_key" ON "StudentDevice"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentDevice_credentialDigest_key" ON "StudentDevice"("credentialDigest");

-- CreateIndex
CREATE INDEX "StudentDevice_classId_idx" ON "StudentDevice"("classId");

-- CreateIndex
CREATE INDEX "StudentLearnerProfile_schoolId_source_externalId_idx" ON "StudentLearnerProfile"("schoolId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentLearnerSession_credentialDigest_key" ON "StudentLearnerSession"("credentialDigest");

-- CreateIndex
CREATE INDEX "StudentLearnerSession_userId_idx" ON "StudentLearnerSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentLearnerSession_deviceId_requestId_key" ON "StudentLearnerSession"("deviceId", "requestId");

-- CreateIndex
CREATE INDEX "StudentAccessAudit_schoolId_createdAt_idx" ON "StudentAccessAudit"("schoolId", "createdAt");

-- AddForeignKey
ALTER TABLE "StudentLearnerProfile" ADD CONSTRAINT "StudentLearnerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
