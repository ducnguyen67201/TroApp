# Backend deployment

Railway is the first target. No cloud resources have been created or deployed. The API now has Google OAuth authentication and a scoped model gateway in addition to service status. The live provider and desktop action path has not been validated for production.

## Railway release plan

1. Create a backend service and PostgreSQL in one Railway project when deployment is authorized.
2. Use this repository's Dockerfile and railway.json. The image contains the backend, not the Electron application.
3. Supply `DATABASE_URL`, a unique `AUTH_SECRET`, the public HTTPS `AUTH_BASE_URL`, and backend-only `OPENAI_API_KEY` through service variables. Keep runtime credentials out of committed files and the desktop bundle. The image defaults to `APP_ENV=prod`; set `APP_ENV=stage` for a staging service.
4. The Docker image sets `HOST=0.0.0.0`. Railway may provide `PORT`; otherwise the API defaults to port 3000. No extra host or port variable is needed in Railway's project settings.
5. The configured pre-deploy step calls the installed Prisma CLI directly with `migrate deploy` (equivalent to local `pnpm db:deploy`). Review migrations before release; never run `migrate dev`, schema resets, or destructive database commands in production.
6. `/health/live` reports process availability; `/health/ready` requires the migrated database. Configure the HTTPS domain, then set the desktop's public API URL for packaging.

Validate the container locally and Railway's release behavior before a production release. Connection pooling, TLS, backups, and recovery must be configured for the database service selected. Do not disable TLS verification to make a connection work.

Railway documents [Dockerfile builds](https://docs.railway.com/builds/dockerfiles), [PostgreSQL](https://docs.railway.com/databases/postgresql), and [pre-deploy commands](https://docs.railway.com/guides/pre-deploy-command).

## Before a public paid release

The implemented Google login and model gateway are a foundation. Set backend-only Google client credentials, register `AUTH_BASE_URL + /api/auth/callback/google` as the production redirect URI, and validate sign-in and session restoration on signed builds. Test limits and billing against abuse, and verify the Cua action path on both operating systems. The gateway must remain authenticated, scoped, and usage-limited.

## AWS later

Keep the Docker image, HTTP contracts, application services, and Prisma model stable where practical. A possible AWS target is ECS/Fargate + RDS PostgreSQL + S3 + Secrets Manager. Moving requires a data migration, networking/IAM configuration, secrets, connection settings, and new deployment checks. It is not an automatic hosting toggle.
