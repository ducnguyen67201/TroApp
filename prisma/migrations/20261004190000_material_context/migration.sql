CREATE TABLE "ClassroomMaterialDerivation" (
  "classId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "jobId" UUID NOT NULL,
  "claimId" UUID NOT NULL,
  "document" JSONB NOT NULL,
  CONSTRAINT "ClassroomMaterialDerivation_pkey" PRIMARY KEY ("classId", "key"),
  CONSTRAINT "ClassroomMaterialDerivation_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ClassroomMaterialDerivation_jobId_idx" ON "ClassroomMaterialDerivation"("jobId");
