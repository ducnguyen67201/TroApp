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
checkout. Run it again whenever you need to change the selection. `pnpm dev` then applies committed
migrations and regenerates the Prisma client before starting the API with Doppler's injected
environment, alongside the desktop without backend secrets. Startup stops if migration fails.

The selected development config owns `APP_ENV`, `DATABASE_URL`, and any provider settings. The
only browser-visible settings are the public `MAIN_VITE_API_BASE_URL` and `MAIN_VITE_APP_ENV`.
See [Development](docs/Development.md) for setup and database commands.

Google sign-in needs backend-only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` plus the redirect URI in [Development](docs/Development.md). Give the backend a unique `AUTH_SECRET`; development startup applies the authentication migration automatically. Chat also needs a backend-only `OPENAI_API_KEY`; the API can start without it.

The desktop build includes a pinned Cua Driver release. The development launcher downloads and verifies that release once before starting Electron. On macOS, Tro checks Screen Recording and Accessibility after Google sign-in and guides you to enable `CuaDriver.app` in System Settings before showing chat. Tro starts a local agent worker on the first task and keeps it warm for 15 minutes after a completed task. Each message has fresh agent context; only the current app window displays its messages, and they disappear when it closes. Model calls and screenshots sent to OpenAI require network access and may incur charges. See [ComputerUseSpec.md](docs/ComputerUseSpec.md) for details and validation limits.

Voice input starts automatically after signing in: hold Command + Control on Mac or Control + Left Alt on Windows, speak, and release to send the final transcript to the agent. It uses GPT Live Transcribe through the authenticated backend and follows the existing English/Vietnamese language choice. A Talk button is available if the global shortcut lacks permission. Development startup applies the transcription migration automatically; hosted releases use the normal reviewed migration workflow. Backend defaults allow one capture at a time and 3,600 audio seconds per account per UTC day. See [VoiceInputSpec.md](docs/VoiceInputSpec.md) for implementation and live/packaged verification limits.

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
