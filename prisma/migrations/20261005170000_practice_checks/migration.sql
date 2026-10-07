-- CreateTable
CREATE TABLE "ClassroomWorkSnapshot" (
    "id" UUID NOT NULL,
    "studentId" TEXT NOT NULL,
    "attemptId" UUID NOT NULL,
    "courseRevisionId" UUID NOT NULL,
    "checkpointId" UUID NOT NULL,
    "rubricRevisionId" UUID NOT NULL,
    "manifestDigest" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassroomWorkSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomPracticeEvidence" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "byteCount" INTEGER NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "ClassroomPracticeEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomPracticeCheck" (
    "id" UUID NOT NULL,
    "studentId" TEXT NOT NULL,
    "attemptId" UUID NOT NULL,
    "checkpointId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "payloadDigest" VARCHAR(64) NOT NULL,
    "rubric" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "finding" TEXT,
    "evaluator" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ClassroomPracticeCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomPracticeResult" (
    "checkId" UUID NOT NULL,
    "criterionId" UUID NOT NULL,
    "finding" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "evidenceIds" JSONB NOT NULL,

    CONSTRAINT "ClassroomPracticeResult_pkey" PRIMARY KEY ("checkId","criterionId")
);

-- CreateTable
CREATE TABLE "ClassroomWorkSubmission" (
    "id" UUID NOT NULL,
    "studentId" TEXT NOT NULL,
    "attemptId" UUID NOT NULL,
    "checkpointId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "checkId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "requestId" UUID NOT NULL,
    "payloadDigest" VARCHAR(64) NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassroomWorkSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassroomWorkSnapshot_studentId_createdAt_idx" ON "ClassroomWorkSnapshot"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "ClassroomWorkSnapshot_attemptId_checkpointId_createdAt_idx" ON "ClassroomWorkSnapshot"("attemptId", "checkpointId", "createdAt");

-- CreateIndex
CREATE INDEX "ClassroomPracticeEvidence_snapshotId_idx" ON "ClassroomPracticeEvidence"("snapshotId");

-- CreateIndex
CREATE INDEX "ClassroomPracticeCheck_studentId_createdAt_idx" ON "ClassroomPracticeCheck"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "ClassroomPracticeCheck_attemptId_createdAt_idx" ON "ClassroomPracticeCheck"("attemptId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomPracticeCheck_studentId_requestId_key" ON "ClassroomPracticeCheck"("studentId", "requestId");

-- CreateIndex
CREATE INDEX "ClassroomWorkSubmission_attemptId_submittedAt_idx" ON "ClassroomWorkSubmission"("attemptId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomWorkSubmission_studentId_requestId_key" ON "ClassroomWorkSubmission"("studentId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomWorkSubmission_attemptId_checkpointId_sequence_key" ON "ClassroomWorkSubmission"("attemptId", "checkpointId", "sequence");

-- AddForeignKey
ALTER TABLE "ClassroomWorkSnapshot" ADD CONSTRAINT "ClassroomWorkSnapshot_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomWorkSnapshot" ADD CONSTRAINT "ClassroomWorkSnapshot_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ClassroomAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomWorkSnapshot" ADD CONSTRAINT "ClassroomWorkSnapshot_courseRevisionId_fkey" FOREIGN KEY ("courseRevisionId") REFERENCES "ClassroomCourseRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomPracticeEvidence" ADD CONSTRAINT "ClassroomPracticeEvidence_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ClassroomWorkSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomPracticeCheck" ADD CONSTRAINT "ClassroomPracticeCheck_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomPracticeCheck" ADD CONSTRAINT "ClassroomPracticeCheck_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ClassroomAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomPracticeCheck" ADD CONSTRAINT "ClassroomPracticeCheck_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ClassroomWorkSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomPracticeResult" ADD CONSTRAINT "ClassroomPracticeResult_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "ClassroomPracticeCheck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomWorkSubmission" ADD CONSTRAINT "ClassroomWorkSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomWorkSubmission" ADD CONSTRAINT "ClassroomWorkSubmission_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ClassroomAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomWorkSubmission" ADD CONSTRAINT "ClassroomWorkSubmission_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ClassroomWorkSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomWorkSubmission" ADD CONSTRAINT "ClassroomWorkSubmission_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "ClassroomPracticeCheck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

