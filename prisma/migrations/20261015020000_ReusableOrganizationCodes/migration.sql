-- Organization activation codes authorize multiple installations. Names belong to
-- installations, so new organization codes no longer need a per-computer label.
-- Preserve all existing codes, installation names, accounts and usage records.
ALTER TABLE "StudentAdmission" DROP CONSTRAINT "StudentAdmission_scope_check";
ALTER TABLE "StudentAdmission" ADD CONSTRAINT "StudentAdmission_scope_check"
  CHECK (("organizationId" IS NULL AND "classId" IS NOT NULL)
    OR ("organizationId" IS NOT NULL AND "classId" IS NULL
      AND "issuedById" IS NOT NULL AND "mode" = 'shared'));
