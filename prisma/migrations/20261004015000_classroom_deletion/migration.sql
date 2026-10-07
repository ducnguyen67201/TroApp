-- Retain student work and historical references when a teacher deletes a class.
ALTER TABLE "ClassroomGroup" ADD COLUMN "deletedAt" TIMESTAMP(3);
