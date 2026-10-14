CREATE TABLE "ClassTeacherAssignment" (
  "classId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  CONSTRAINT "ClassTeacherAssignment_pkey" PRIMARY KEY ("classId", "userId"),
  CONSTRAINT "ClassTeacherAssignment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClassTeacherAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ClassTeacherAssignment_userId_idx" ON "ClassTeacherAssignment"("userId");
-- Preserve every existing assignment, including historical and personal classes.
INSERT INTO "ClassTeacherAssignment" ("classId", "userId")
SELECT "id", "teacherId" FROM "ClassroomGroup";
