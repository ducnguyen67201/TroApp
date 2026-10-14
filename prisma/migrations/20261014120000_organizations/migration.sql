-- Existing classrooms remain unscoped until an explicit administrator mapping is supplied.
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_membership" (
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "AccountRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "organization_membership_pkey" PRIMARY KEY ("organizationId", "userId")
);

CREATE TABLE "organization_invitation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "AccountRole" NOT NULL,
    "codeDigest" VARCHAR(64) NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organization_invitation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ClassroomGroup" ADD COLUMN "organizationId" UUID;
ALTER TABLE "ClassroomCourseRevision" ADD COLUMN "organizationId" UUID;

CREATE INDEX "organization_ownerUserId_idx" ON "organization"("ownerUserId");
CREATE INDEX "organization_membership_userId_removedAt_idx" ON "organization_membership"("userId", "removedAt");
CREATE UNIQUE INDEX "organization_invitation_codeDigest_key" ON "organization_invitation"("codeDigest");
CREATE INDEX "organization_invitation_organizationId_email_idx" ON "organization_invitation"("organizationId", "email");
CREATE INDEX "organization_invitation_organizationId_expiresAt_idx" ON "organization_invitation"("organizationId", "expiresAt");
CREATE INDEX "ClassroomGroup_organizationId_idx" ON "ClassroomGroup"("organizationId");
CREATE INDEX "ClassroomCourseRevision_organizationId_idx" ON "ClassroomCourseRevision"("organizationId");

ALTER TABLE "organization" ADD CONSTRAINT "organization_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomGroup" ADD CONSTRAINT "ClassroomGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassroomCourseRevision" ADD CONSTRAINT "ClassroomCourseRevision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce the active-owner invariant at commit, allowing organization/member creation together.
CREATE FUNCTION "require_active_organization_owner"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE organization_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'organization' THEN
    organization_id := NEW."id";
  ELSE
    IF TG_OP = 'UPDATE' AND (
      NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR
      NEW."userId" IS DISTINCT FROM OLD."userId"
    ) THEN
      RAISE EXCEPTION 'Organization membership identity cannot change' USING ERRCODE = '23514';
    END IF;
    organization_id := COALESCE(NEW."organizationId", OLD."organizationId");
  END IF;
  IF EXISTS (
    SELECT 1 FROM "organization" o
    WHERE o."id" = organization_id
      AND NOT EXISTS (
        SELECT 1 FROM "organization_membership" m
        WHERE m."organizationId" = o."id" AND m."userId" = o."ownerUserId" AND m."removedAt" IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'Organization owner must be an active member' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "organization_requires_active_owner"
  AFTER INSERT OR UPDATE ON "organization" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "require_active_organization_owner"();
CREATE CONSTRAINT TRIGGER "membership_preserves_active_owner"
  AFTER INSERT OR UPDATE OR DELETE ON "organization_membership" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "require_active_organization_owner"();
