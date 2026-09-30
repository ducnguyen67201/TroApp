# Tro

An Electron + React desktop foundation with a strict TypeScript API and Prisma/PostgreSQL persistence boundary. Railway is the first backend deployment target; AWS remains a later option.

The working slice reports backend and database readiness in the desktop window. Authentication, try-on, agent execution, and computer control are planned capabilities, not implemented features.

Read [Architecture](docs/Architecture.md) for the local/cloud split, [Development](docs/Development.md) for commands, and [repository instructions](AGENTS.md) for naming and formatting.

## Quick start

Use Node.js 24 LTS and pnpm 11. Install the Doppler CLI and make sure the shared development
PostgreSQL container is already running.

```sh
pnpm install
doppler login
pnpm dev:setup
pnpm dev
```

`pnpm dev:setup` delegates project and development-config selection to Doppler and saves that
choice for this checkout. Run it again whenever you need to change the selection. `pnpm dev` then
starts the API with Doppler's injected environment and starts the desktop without backend secrets.

The selected development config owns `APP_ENV`, `DATABASE_URL`, and any provider settings. The
only browser-visible settings are the public `MAIN_VITE_API_BASE_URL` and `MAIN_VITE_APP_ENV`.
See [Development](docs/Development.md) for setup and database commands.

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
