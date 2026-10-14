-- Existing accounts retain their current role and receive no administrator access.
ALTER TABLE "user" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
