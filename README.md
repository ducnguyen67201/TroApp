# Tro

An Electron + React desktop foundation with a strict TypeScript API and Prisma/PostgreSQL persistence boundary. Railway is the first backend deployment target; AWS remains a later option.

The desktop includes a local computer-use chat prototype with Google sign-in through the system browser. A backend model gateway is implemented; try-on remains planned.

Read [Architecture](docs/Architecture.md) for the local/cloud split, [Development](docs/Development.md) for commands, and [repository instructions](AGENTS.md) for naming and formatting.

## Quick start

Use Node.js 24 LTS and pnpm 11. Install the Doppler CLI and make sure the shared development
PostgreSQL container is already running.

```sh
pnpm install
doppler login
pnpm select
pnpm dev
```

`pnpm select` delegates selection to Doppler: choose the `tro-api` project, then the appropriate
development environment/config (`dev` or `dev_personal`). Doppler saves that choice for this
checkout. Run it again whenever you need to change the selection. `pnpm dev` then starts the API
with Doppler's injected environment and starts the desktop without backend secrets.

The selected development config owns `APP_ENV`, `DATABASE_URL`, and any provider settings. The
only browser-visible settings are the public `MAIN_VITE_API_BASE_URL` and `MAIN_VITE_APP_ENV`.
See [Development](docs/Development.md) for setup and database commands.

Google sign-in needs backend-only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` plus the redirect URI in [Development](docs/Development.md). Give the backend a unique `AUTH_SECRET` and apply the authentication migration before signing in. Chat also needs a backend-only `OPENAI_API_KEY`; the API can start without it.

The desktop build includes a pinned Cua Driver release. The development launcher downloads and verifies that release once before starting Electron. On macOS, grant Screen Recording and Accessibility to `CuaDriver.app` in System Settings. Tro starts a local agent worker on the first task and keeps it warm for 15 minutes after a completed task. Each message has fresh agent context; only the current app window displays its messages, and they disappear when it closes. Model calls and screenshots sent to OpenAI require network access and may incur charges. See [ComputerUseSpec.md](docs/ComputerUseSpec.md) for details and validation limits.

## Ownership

| Folder          | Owns                                                              |
| --------------- | ----------------------------------------------------------------- |
| `src/desktop`   | Electron main, preload, React, local agent worker, Cua MCP client |
| `src/contracts` | Runtime schemas and public response types                         |
| `src/server`    | API composition, application services, database ports/adapters    |
| `prisma`        | Schema and versioned migrations                                   |
| `scripts`       | Boundary checks and local integration harness                     |
| `docs`          | Architecture, development workflow, deployment decisions          |

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
