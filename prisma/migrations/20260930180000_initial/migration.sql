CREATE TABLE "OutfitDraft" (
  "id" UUID NOT NULL,
  "ownerId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutfitDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutfitDraft_ownerId_createdAt_idx" ON "OutfitDraft"("ownerId", "createdAt");
