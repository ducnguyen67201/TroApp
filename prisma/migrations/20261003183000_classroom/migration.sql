-- CreateTable
CREATE TABLE "ClassroomCourseRevision" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassroomCourseRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomGroup" (
    "id" UUID NOT NULL,
    "teacherId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "courseRevisionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassroomGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomEnrollment" (
    "classId" UUID NOT NULL,
    "studentId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ClassroomEnrollment_pkey" PRIMARY KEY ("classId","studentId")
);

-- CreateTable
CREATE TABLE "ClassroomMeeting" (
    "id" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "pacing" TEXT NOT NULL,
    "currentActivityId" UUID NOT NULL,
    "contextVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassroomMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomParticipation" (
    "id" UUID NOT NULL,
    "classSessionId" UUID NOT NULL,
    "studentId" TEXT NOT NULL,
    "deviceId" UUID NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "left" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ClassroomParticipation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomAttempt" (
    "id" UUID NOT NULL,
    "participationId" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "progressVersion" INTEGER NOT NULL DEFAULT 0,
    "workspaceUrl" TEXT,
    "evidence" JSONB NOT NULL,
    "declaredComplete" BOOLEAN NOT NULL DEFAULT false,
    "helpSummary" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ClassroomAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomProgressEvent" (
    "attemptId" UUID NOT NULL,
    "eventId" UUID NOT NULL,

    CONSTRAINT "ClassroomProgressEvent_pkey" PRIMARY KEY ("attemptId","eventId")
);

-- CreateTable
CREATE TABLE "ClassroomSubmissionPreparation" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "progressVersion" INTEGER NOT NULL,
    "contextVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassroomSubmissionPreparation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassroomSubmission" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassroomSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassroomCourseRevision_ownerId_createdAt_idx" ON "ClassroomCourseRevision"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "ClassroomGroup_teacherId_idx" ON "ClassroomGroup"("teacherId");

-- CreateIndex
CREATE INDEX "ClassroomEnrollment_studentId_active_idx" ON "ClassroomEnrollment"("studentId", "active");

-- CreateIndex
CREATE INDEX "ClassroomMeeting_classId_createdAt_idx" ON "ClassroomMeeting"("classId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomParticipation_classSessionId_studentId_key" ON "ClassroomParticipation"("classSessionId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomAttempt_participationId_activityId_key" ON "ClassroomAttempt"("participationId", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomSubmission_attemptId_idempotencyKey_key" ON "ClassroomSubmission"("attemptId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ClassroomCourseRevision" ADD CONSTRAINT "ClassroomCourseRevision_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomGroup" ADD CONSTRAINT "ClassroomGroup_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomGroup" ADD CONSTRAINT "ClassroomGroup_courseRevisionId_fkey" FOREIGN KEY ("courseRevisionId") REFERENCES "ClassroomCourseRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomEnrollment" ADD CONSTRAINT "ClassroomEnrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomEnrollment" ADD CONSTRAINT "ClassroomEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomMeeting" ADD CONSTRAINT "ClassroomMeeting_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomParticipation" ADD CONSTRAINT "ClassroomParticipation_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassroomMeeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomParticipation" ADD CONSTRAINT "ClassroomParticipation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomAttempt" ADD CONSTRAINT "ClassroomAttempt_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomProgressEvent" ADD CONSTRAINT "ClassroomProgressEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ClassroomAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomSubmissionPreparation" ADD CONSTRAINT "ClassroomSubmissionPreparation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ClassroomAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomSubmission" ADD CONSTRAINT "ClassroomSubmission_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ClassroomAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
