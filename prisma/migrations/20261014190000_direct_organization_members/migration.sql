ALTER TABLE "user" ADD COLUMN "canCreateOrganization" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN "hasChosenOrganization" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "organization_email_member" (
  "organizationId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "role" "AccountRole" NOT NULL,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_email_member_pkey" PRIMARY KEY ("organizationId", "email"),
  CONSTRAINT "organization_email_member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "organization_email_member_email_idx" ON "organization_email_member"("email");

-- Keep existing organization users out of the new first-login choice.
UPDATE "user" u SET "hasChosenOrganization" = true
WHERE EXISTS (SELECT 1 FROM "organization_membership" m JOIN "organization" o ON o."id" = m."organizationId" WHERE m."userId" = u."id" AND m."removedAt" IS NULL AND o."nameSetAt" IS NOT NULL);
UPDATE "user" u SET "canCreateOrganization" = true
WHERE EXISTS (SELECT 1 FROM "organization" o WHERE o."ownerUserId" = u."id" AND o."nameSetAt" IS NULL);

-- Current, unexpired invitations become direct additions, with no code or expiry.
INSERT INTO "organization_email_member" ("organizationId", "email", "role", "addedAt")
SELECT DISTINCT ON (i."organizationId", lower(i."email")) i."organizationId", lower(i."email"), i."role", i."createdAt"
FROM "organization_invitation" i JOIN "organization" o ON o."id" = i."organizationId"
WHERE i."acceptedAt" IS NULL AND i."revokedAt" IS NULL AND i."expiresAt" > CURRENT_TIMESTAMP AND i."invitedByUserId" = o."ownerUserId"
ORDER BY i."organizationId", lower(i."email"), i."createdAt" DESC;
UPDATE "organization_invitation" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
