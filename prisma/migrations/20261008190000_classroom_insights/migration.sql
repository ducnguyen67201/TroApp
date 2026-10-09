-- Additive versioned insight storage. Existing classroom and private evidence remain unchanged.
CREATE TABLE "ClassroomInsightState" (
 "collectionPolicy" TEXT, "retentionDays" INTEGER,
  "classId" UUID NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  "invalidationRevision" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClassroomInsightState_pkey" PRIMARY KEY ("classId")
);
CREATE TABLE "ClassroomLearningEvent" (
 "logicalId" TEXT NOT NULL,
  "id" UUID NOT NULL, "classId" UUID NOT NULL, "revision" BIGINT NOT NULL,
  "identity" TEXT NOT NULL, "kind" TEXT NOT NULL, "studentId" TEXT,
  "sessionId" UUID, "attemptId" UUID, "activityId" UUID, "sourceId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL, "observedAt" TIMESTAMP(3), "recordedAt" TIMESTAMP(3) NOT NULL,
  "payloadDigest" VARCHAR(64) NOT NULL, "record" JSONB NOT NULL,
  CONSTRAINT "ClassroomLearningEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ClassroomInsightRecord" (
 "episodeOrder" INTEGER,
  "id" UUID NOT NULL, "classId" UUID NOT NULL, "kind" TEXT NOT NULL,
  "logicalId" TEXT NOT NULL, "version" INTEGER NOT NULL, "revision" BIGINT NOT NULL,
  "studentId" TEXT, "sessionId" UUID, "sourceId" TEXT, "supersedesId" UUID,
  "removedAt" TIMESTAMP(3), "recordedAt" TIMESTAMP(3) NOT NULL, "record" JSONB NOT NULL,
  CONSTRAINT "ClassroomInsightRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClassroomLearningEvent_classId_identity_key" ON "ClassroomLearningEvent"("classId", "identity");
CREATE UNIQUE INDEX "ClassroomLearningEvent_classId_revision_key" ON "ClassroomLearningEvent"("classId", "revision");
CREATE INDEX "ClassroomLearningEvent_classId_studentId_revision_idx" ON "ClassroomLearningEvent"("classId", "studentId", "revision");
CREATE INDEX "ClassroomLearningEvent_classId_recordedAt_id_idx" ON "ClassroomLearningEvent"("classId", "recordedAt", "id");
CREATE UNIQUE INDEX "ClassroomInsightRecord_classId_logicalId_version_key" ON "ClassroomInsightRecord"("classId", "logicalId", "version");
CREATE INDEX "ClassroomInsightRecord_classId_kind_revision_idx" ON "ClassroomInsightRecord"("classId", "kind", "revision");
CREATE INDEX "ClassroomInsightRecord_classId_studentId_revision_idx" ON "ClassroomInsightRecord"("classId", "studentId", "revision");
CREATE INDEX "ClassroomInsightRecord_classId_sourceId_idx" ON "ClassroomInsightRecord"("classId", "sourceId");
ALTER TABLE "ClassroomInsightState" ADD CONSTRAINT "ClassroomInsightState_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomLearningEvent" ADD CONSTRAINT "ClassroomLearningEvent_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomInsightRecord" ADD CONSTRAINT "ClassroomInsightRecord_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ClassroomInsightReceipt" (
 "userId" TEXT NOT NULL, "requestId" UUID NOT NULL, "classId" UUID NOT NULL,
 "digest" VARCHAR(64) NOT NULL, "reply" JSONB NOT NULL,
 CONSTRAINT "ClassroomInsightReceipt_pkey" PRIMARY KEY ("userId", "requestId")
);
CREATE INDEX "ClassroomInsightReceipt_classId_idx" ON "ClassroomInsightReceipt"("classId");

CREATE TABLE "ClassroomExpiredSource" (
 "classId" UUID NOT NULL, "sourceId" TEXT NOT NULL, "expiredAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ClassroomExpiredSource_pkey" PRIMARY KEY ("classId", "sourceId")
);

ALTER TABLE "ClassroomWorkSnapshot" ADD COLUMN "expiredAt" TIMESTAMP(3);

CREATE INDEX "ClassroomLearningEvent_classId_logicalId_idx" ON "ClassroomLearningEvent"("classId","logicalId");

ALTER TABLE "ClassroomInsightReceipt" ADD CONSTRAINT "ClassroomInsightReceipt_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomExpiredSource" ADD CONSTRAINT "ClassroomExpiredSource_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ClassroomAttempt" ADD COLUMN "lastSavedAt" TIMESTAMP(3);

CREATE INDEX "ClassroomInsightRecord_classId_studentId_episodeOrder_idx" ON "ClassroomInsightRecord"("classId","studentId","episodeOrder");
