CREATE TABLE "TranscriptionUsage" (
  "userId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "samples" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "TranscriptionUsage_pkey" PRIMARY KEY ("userId", "day")
);
CREATE TABLE "TranscriptionCapture" (
  "id" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "activeUserId" TEXT,
  "day" DATE NOT NULL,
  "reservedSamples" INTEGER NOT NULL,
  "claimed" BOOLEAN NOT NULL DEFAULT false,
  "settled" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TranscriptionCapture_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TranscriptionCapture_activeUserId_key" ON "TranscriptionCapture"("activeUserId");
CREATE INDEX "TranscriptionCapture_userId_expiresAt_idx" ON "TranscriptionCapture"("userId", "expiresAt");
ALTER TABLE "TranscriptionUsage" ADD CONSTRAINT "TranscriptionUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranscriptionCapture" ADD CONSTRAINT "TranscriptionCapture_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
