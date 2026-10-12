CREATE TABLE "LessonRenderOperationRecord" (
  "id" UUID NOT NULL,
  "lessonId" UUID,
  "cleanupPending" BOOLEAN NOT NULL,
  "document" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LessonRenderOperationRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LessonRenderOperationRecord_cleanupPending_updatedAt_idx" ON "LessonRenderOperationRecord"("cleanupPending", "updatedAt");
CREATE INDEX "LessonRenderOperationRecord_lessonId_idx" ON "LessonRenderOperationRecord"("lessonId");

CREATE TABLE "LessonRenderSceneRecord" (
  "id" TEXT NOT NULL,
  "lessonId" UUID NOT NULL,
  "result" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LessonRenderSceneRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LessonRenderSceneRecord_lessonId_idx" ON "LessonRenderSceneRecord"("lessonId");
CREATE INDEX "LessonRenderSceneRecord_updatedAt_idx" ON "LessonRenderSceneRecord"("updatedAt");
