-- Personal installations can retain QR logins alongside encrypted Google sessions.
-- Existing company installations keep their shared mode and temporary sessions.
ALTER TABLE "StudentDevice" DROP CONSTRAINT "StudentDevice_scope_check";
ALTER TABLE "StudentDevice" ADD CONSTRAINT "StudentDevice_scope_check"
  CHECK (("organizationId" IS NULL AND "classId" IS NOT NULL)
    OR ("organizationId" IS NOT NULL AND "classId" IS NULL AND "computerName" IS NOT NULL
      AND "mode" IN ('personal', 'shared')));
