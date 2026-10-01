CREATE TYPE "UserRole" AS ENUM ('OWNER', 'MEMBER');

CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "googleSubject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "displayName" VARCHAR(120),
    "avatarUrl" VARCHAR(2048),
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "workspaceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthIdentity" (
    "id" UUID NOT NULL,
    "googleSubject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "displayName" VARCHAR(120),
    "avatarUrl" VARCHAR(2048),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthFlow" (
    "id" UUID NOT NULL,
    "stateHash" CHAR(64) NOT NULL,
    "codeVerifier" VARCHAR(128) NOT NULL,
    "nonce" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthFlow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthHandoff" (
    "id" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "identityId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthHandoff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "identityId" UUID NOT NULL,
    "userId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_googleSubject_key" ON "User"("googleSubject");
CREATE INDEX "User_workspaceId_idx" ON "User"("workspaceId");
CREATE UNIQUE INDEX "AuthIdentity_googleSubject_key" ON "AuthIdentity"("googleSubject");
CREATE UNIQUE INDEX "OAuthFlow_stateHash_key" ON "OAuthFlow"("stateHash");
CREATE INDEX "OAuthFlow_expiresAt_idx" ON "OAuthFlow"("expiresAt");
CREATE UNIQUE INDEX "AuthHandoff_codeHash_key" ON "AuthHandoff"("codeHash");
CREATE INDEX "AuthHandoff_expiresAt_idx" ON "AuthHandoff"("expiresAt");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_identityId_idx" ON "Session"("identityId");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

ALTER TABLE "User" ADD CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthHandoff" ADD CONSTRAINT "AuthHandoff_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "AuthIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "AuthIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
