-- Preserve legacy class grants and learner accounts. Organization QR identities
-- are separate: NULL organization IDs allow existing duplicate legacy claims.
ALTER TABLE "StudentAdmission" ALTER COLUMN "classId" DROP NOT NULL;
ALTER TABLE "StudentAdmission" ADD COLUMN "organizationId" UUID,
  ADD COLUMN "issuedById" TEXT, ADD COLUMN "computerName" TEXT;
ALTER TABLE "StudentDevice" ALTER COLUMN "classId" DROP NOT NULL;
ALTER TABLE "StudentDevice" ADD COLUMN "organizationId" UUID,
  ADD COLUMN "computerName" TEXT, ADD COLUMN "lastSignInAt" TIMESTAMP(3);
ALTER TABLE "StudentLearnerProfile" ADD COLUMN "organizationId" UUID;
CREATE INDEX "StudentAdmission_organizationId_revoked_idx" ON "StudentAdmission"("organizationId", "revoked");
CREATE INDEX "StudentDevice_organizationId_idx" ON "StudentDevice"("organizationId");
CREATE UNIQUE INDEX "StudentLearnerProfile_organizationId_source_externalId_key"
  ON "StudentLearnerProfile"("organizationId", "source", "externalId");
ALTER TABLE "StudentAdmission" ADD CONSTRAINT "StudentAdmission_scope_check"
  CHECK (("organizationId" IS NULL AND "classId" IS NOT NULL)
    OR ("organizationId" IS NOT NULL AND "classId" IS NULL AND "issuedById" IS NOT NULL
      AND "computerName" IS NOT NULL AND "mode" = 'shared'));
ALTER TABLE "StudentDevice" ADD CONSTRAINT "StudentDevice_scope_check"
  CHECK (("organizationId" IS NULL AND "classId" IS NOT NULL)
    OR ("organizationId" IS NOT NULL AND "classId" IS NULL AND "computerName" IS NOT NULL AND "mode" = 'shared'));
