-- Frozen legacy user shape: newer Prisma clients inject columns absent before the upgrade.
INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
