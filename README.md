# Tro

An Electron + React desktop foundation with a strict TypeScript API and Prisma/PostgreSQL persistence boundary. Railway is the first backend deployment target; AWS remains a later option.

The working slice reports backend and database readiness in the desktop window. Authentication, try-on, agent execution, and computer control are planned capabilities, not implemented features.

Read [Architecture](docs/Architecture.md) for the local/cloud split, [Development](docs/Development.md) for commands, and [repository instructions](AGENTS.md) for naming and formatting.

## Quick start

Use Node.js 24 LTS and pnpm 11. Install Docker Desktop and the Doppler CLI. Ask a Tro
workspace administrator for access to the `tro` project and its dedicated `dev_local`
configuration, then authenticate once with `doppler login`.

```sh
pnpm install
pnpm dev
```

`pnpm dev` verifies the toolchain and Doppler access, starts and health-checks PostgreSQL,
refuses any non-local migration target, applies migrations, generates Prisma, and starts the API
and desktop together. Re-running it is safe when the database and migrations already exist.
Ctrl-C stops the application processes but preserves the local database volume.

The Doppler config must set `APP_ENV=dev` and its `DATABASE_URL` must target the Compose
database at `127.0.0.1:54329/tro`. Backend secrets are never passed to the desktop. The only
browser-visible settings are the allowlisted `MAIN_VITE_API_BASE_URL` and
`MAIN_VITE_APP_ENV`. See [Development](docs/Development.md) for first-time setup, recovery,
configuration overrides, and the manual startup sequence.

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
