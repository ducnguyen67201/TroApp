CREATE TABLE "VoiceoverUsage" ("userId" TEXT NOT NULL, "day" DATE NOT NULL, "characters" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "VoiceoverUsage_pkey" PRIMARY KEY ("userId", "day"));
CREATE TABLE "VoiceoverDailyBudget" ("day" DATE NOT NULL, "characters" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "VoiceoverDailyBudget_pkey" PRIMARY KEY ("day"));
CREATE TABLE "VoiceoverUtterance" ("id" UUID NOT NULL, "userId" TEXT NOT NULL, "activeUserId" TEXT, "characters" INTEGER NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "VoiceoverUtterance_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "VoiceoverUtterance_activeUserId_key" ON "VoiceoverUtterance"("activeUserId");
CREATE INDEX "VoiceoverUtterance_expiresAt_idx" ON "VoiceoverUtterance"("expiresAt");
ALTER TABLE "VoiceoverUsage" ADD CONSTRAINT "VoiceoverUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceoverUtterance" ADD CONSTRAINT "VoiceoverUtterance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
