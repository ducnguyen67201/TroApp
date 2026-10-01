# Tro

An Electron + React desktop application with Google sign-in, required workspace onboarding, a strict TypeScript API, and Prisma/PostgreSQL persistence. Railway is the first backend deployment target; AWS remains a later option.

The working slice authenticates through the system browser, stores the desktop session through OS-protected Electron storage, and creates the first workspace owner transactionally. Try-on, agent execution, and computer control remain planned capabilities.

Read [Architecture](docs/Architecture.md) for the local/cloud split, [Development](docs/Development.md) for commands, and [repository instructions](AGENTS.md) for naming and formatting.

## Quick start

Use Node.js 24 LTS and pnpm 11. Install Docker Desktop to run the optional local database.

```sh
pnpm install
cp .env.example .env
pnpm db:start
pnpm db:migrate
pnpm dev
```

`pnpm dev` starts the API and desktop application together. Without PostgreSQL, the API still starts and the desktop shows that the database is unavailable. No real accounts, photographs, or AI credentials are required.

For local development, configure PostgreSQL and a Google OAuth web client through Doppler or `.env`; optional `APP_ENV` accepts `dev`, `stage`, or `prod`. The API and desktop use matching local defaults. See [Google sign-in](docs/GoogleSignIn.md) and [Development](docs/Development.md).

## Ownership

| Folder          | Owns                                                           |
| --------------- | -------------------------------------------------------------- |
| `src/desktop`   | Electron main process, preload bridge, React interface         |
| `src/contracts` | Runtime schemas and public response types                      |
| `src/server`    | API composition, application services, database ports/adapters |
| `prisma`        | Schema and versioned migrations                                |
| `scripts`       | Boundary checks and local integration harness                  |
| `docs`          | Architecture, development workflow, deployment decisions       |

## Validation

Finish related edits first, then run:

```sh
pnpm format
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
```

Integration tests require a running Docker daemon and use a disposable PostgreSQL container. Packaging requires separate macOS/Windows validation and signing.
