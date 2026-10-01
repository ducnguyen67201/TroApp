# Backend deployment

Railway is the first target. No cloud resources have been created or deployed. The API exposes readiness, Google authentication, server-side sessions, and workspace onboarding, but no model gateway.

## Railway release plan

1. Create a backend service and PostgreSQL in one Railway project when deployment is authorized.
2. Use this repository's Dockerfile and railway.json. The image contains the backend, not the Electron application.
3. Supply the database connection URL and Google OAuth settings through Doppler-managed runtime variables. Keep `GOOGLE_CLIENT_SECRET` and database credentials backend-only, never in Railway build arguments or the desktop bundle. The image defaults to `APP_ENV=prod`; set `APP_ENV=stage` for a staging service.
4. The Docker image sets `HOST=0.0.0.0`. Railway may provide `PORT`; otherwise the API defaults to port 3000. No extra host or port variable is needed in Railway's project settings.
5. The configured pre-deploy step calls the installed Prisma CLI directly with `migrate deploy` (equivalent to local `pnpm db:deploy`). Review migrations before release; never run `migrate dev`, schema resets, or destructive database commands in production.
6. `/health/live` reports process availability; `/health/ready` requires the migrated database. Configure the HTTPS domain and exact Google callback URI, then set the desktop's public API URL for packaging.

Validate the container locally and Railway's release behavior before a production release. Connection pooling, TLS, backups, and recovery must be configured for the database service selected. Do not disable TLS verification to make a connection work.

Railway documents [Dockerfile builds](https://docs.railway.com/builds/dockerfiles), [PostgreSQL](https://docs.railway.com/databases/postgresql), and [pre-deploy commands](https://docs.railway.com/guides/pre-deploy-command).

## Before paid model or customer-data features

Add user/agent authorization for each new data path, plus usage limits, private storage, cancellation, and safe trace retention with the actual feature. An unauthenticated OpenAI proxy must not be deployed.

## AWS later

Keep the Docker image, HTTP contracts, application services, and Prisma model stable where practical. A possible AWS target is ECS/Fargate + RDS PostgreSQL + S3 + Secrets Manager. Moving requires a data migration, networking/IAM configuration, secrets, connection settings, and new deployment checks. It is not an automatic hosting toggle.
