# Tro

An Electron + React desktop foundation with a strict TypeScript API and Prisma/PostgreSQL persistence boundary. Railway is the first backend deployment target; AWS remains a later option.

The desktop includes a local computer-use chat prototype with Google sign-in through the system browser. A backend model gateway is implemented; try-on remains planned.

Read [Architecture](docs/Architecture.md) for the local/cloud split, [Development](docs/Development.md) for commands, and [repository instructions](AGENTS.md) for naming and formatting.

## Quick start

Use Node.js 24 LTS and pnpm 11. Install Docker Desktop to run the optional local database.

```sh
pnpm install
doppler setup
# Select tro-api and your development config; set AUTH_SECRET in Doppler.
pnpm db:start
doppler run -- pnpm db:migrate
doppler run -- pnpm dev
```

`pnpm dev` starts the API and desktop application together. Google sign-in needs backend-only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` plus the redirect URI in [Development](docs/Development.md). The API can start without an OpenAI key, but chat requires a server-side `OPENAI_API_KEY`.

To use the computer-use chat, install Tro's desktop build, which includes a pinned Cua Driver release. The development launcher downloads and verifies that release once before starting Electron. On macOS, grant Screen Recording and Accessibility to `CuaDriver.app` in System Settings. Set a unique backend `AUTH_SECRET`, `OPENAI_API_KEY`, and Google OAuth credentials in Doppler, apply migrations, sign in with Google, and send a message. Tro starts a local agent worker on the first task and keeps it warm for 15 minutes after a completed task. Each message has fresh agent context; only the current app window displays its messages, and they disappear when it closes. Model calls and screenshots the agent sends to OpenAI require network access and may incur charges. See [ComputerUseSpec.md](docs/ComputerUseSpec.md) for details and validation limits. To keep backend credentials out of the desktop process environment, use the separate Doppler commands in [Development](docs/Development.md).

For local development, Doppler supplies `DATABASE_URL` and a unique `AUTH_SECRET`; chat also needs backend `OPENAI_API_KEY`. Generate the secret with `openssl rand -base64 32` and save it in Doppler. The API dev command does not load `.env`. Optional `APP_ENV` accepts `dev`, `stage`, or `prod`. The API and desktop use matching local defaults. When packaging an installer, set the public `MAIN_VITE_API_BASE_URL` at build time; see [Development](docs/Development.md).

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
