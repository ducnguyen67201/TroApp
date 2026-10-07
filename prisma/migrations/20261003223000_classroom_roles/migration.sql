-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('student', 'teacher');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "role" "AccountRole" NOT NULL DEFAULT 'student';

-- CreateTable
CREATE TABLE "ClassroomInvitation" (
    "id" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "codeDigest" TEXT NOT NULL,
    "email" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ClassroomInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomInvitation_codeDigest_key" ON "ClassroomInvitation"("codeDigest");

-- CreateIndex
CREATE INDEX "ClassroomInvitation_classId_revoked_idx" ON "ClassroomInvitation"("classId", "revoked");

-- AddForeignKey
ALTER TABLE "ClassroomInvitation" ADD CONSTRAINT "ClassroomInvitation_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve existing curriculum/class owners while other accounts default to students.
UPDATE "user" SET "role" = 'teacher'
WHERE EXISTS (SELECT 1 FROM "ClassroomGroup" WHERE "teacherId" = "user"."id")
   OR EXISTS (SELECT 1 FROM "ClassroomCourseRevision" WHERE "ownerId" = "user"."id");
