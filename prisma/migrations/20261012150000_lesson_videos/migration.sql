CREATE TABLE "LessonVideo" (
 "id" UUID PRIMARY KEY, "ownerId" TEXT NOT NULL, "requestId" UUID NOT NULL,
 "status" TEXT NOT NULL, "revision" INTEGER NOT NULL, "recordVersion" INTEGER NOT NULL DEFAULT 0,
 "claimId" UUID, "leaseUntil" TIMESTAMP(3), "state" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "LessonVideo_ownerId_requestId_key" ON "LessonVideo"("ownerId", "requestId");
CREATE INDEX "LessonVideo_status_leaseUntil_createdAt_idx" ON "LessonVideo"("status", "leaseUntil", "createdAt");
CREATE INDEX "LessonVideo_ownerId_createdAt_idx" ON "LessonVideo"("ownerId", "createdAt");
CREATE TABLE "LessonVideoScreen" (
 "id" UUID PRIMARY KEY, "lessonId" UUID NOT NULL REFERENCES "LessonVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "position" INTEGER NOT NULL, "state" JSONB NOT NULL
);
CREATE UNIQUE INDEX "LessonVideoScreen_lessonId_position_key" ON "LessonVideoScreen"("lessonId", "position");
CREATE TABLE "LessonVideoArtifact" (
 "id" UUID PRIMARY KEY, "lessonId" UUID NOT NULL REFERENCES "LessonVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "kind" TEXT NOT NULL, "bytes" BYTEA NOT NULL, "byteLength" INTEGER NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LessonVideoArtifact_lessonId_idx" ON "LessonVideoArtifact"("lessonId");
CREATE TABLE "LessonVideoAllowance" (
 "scope" TEXT NOT NULL, "day" TEXT NOT NULL, "reservedMicroUsd" INTEGER NOT NULL, "characters" INTEGER NOT NULL,
 PRIMARY KEY ("scope", "day")
);
