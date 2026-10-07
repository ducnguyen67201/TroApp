CREATE TABLE "ClassroomMaterialCollection" (
 "classId" UUID PRIMARY KEY REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT,
 "version" INTEGER NOT NULL, "state" TEXT NOT NULL, "leaseUntil" TIMESTAMP(3), "document" JSONB NOT NULL
);
CREATE TABLE "ClassroomMaterialFile" (
 "id" UUID PRIMARY KEY, "classId" UUID NOT NULL REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT,
 "name" TEXT NOT NULL, "bytes" BYTEA NOT NULL, "size" INTEGER NOT NULL
);
CREATE INDEX "ClassroomMaterialFile_classId_idx" ON "ClassroomMaterialFile"("classId");
CREATE TABLE "ClassroomMaterialPublication" (
 "courseId" UUID PRIMARY KEY REFERENCES "ClassroomCourseRevision"("id") ON DELETE RESTRICT,
 "document" JSONB NOT NULL
);

CREATE TABLE "ClassroomMaterialBudget" ("id" TEXT PRIMARY KEY, "requests" INTEGER NOT NULL);
