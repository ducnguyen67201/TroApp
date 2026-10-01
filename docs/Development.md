# Development workflow

## Start locally

Use Node.js 24 LTS and pnpm 11. The repository is its own pnpm root and does not consume sibling
projects. Install the Doppler CLI and make sure the shared development PostgreSQL container is
already running.

For first-time setup, authenticate and let Doppler select the project and development config:

```sh
pnpm install
doppler login
pnpm select
pnpm dev
```

`pnpm select` is only a thin alias for `doppler setup`. At Doppler's prompts, select the `tro-api`
project and then the appropriate development environment/config (`dev` or `dev_personal`). Doppler
stores the selection for this checkout; run the command again whenever you want to change it. The
selected development config supplies `APP_ENV`, `DATABASE_URL`, and any backend provider settings.

`pnpm dev` uses the saved Doppler selection for the API and launches the desktop alongside it.
Before starting the API watcher, `dev:api` applies committed migrations with `prisma migrate
deploy` and regenerates the Prisma client. A migration or generation failure stops API startup
and the combined development command. The desktop process is not wrapped in `doppler run`, so
backend configuration is not injected into Electron or Vite. Ctrl-C terminates both development
processes.

The API binds to `127.0.0.1:3000` locally. PostgreSQL binds to `127.0.0.1:54329`. The desktop main process calls the API; the React renderer has no generic network or database bridge. Development reload is handled by electron-vite and Node's watch mode with tsx.

The selected `tro-api` config needs `DATABASE_URL` and a unique `AUTH_SECRET` (`openssl rand -base64 32`). Chat also needs a backend-only `OPENAI_API_KEY`. Google sign-in needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the API only. Create a Google OAuth **Web application** client with authorized redirect URI `http://127.0.0.1:3000/api/auth/callback/google` (match `AUTH_BASE_URL` exactly). Save the generated secret in Doppler before running. Optional `APP_ENV=dev|stage|prod` selects the backend application mode; it defaults to `dev`.

Pino emits debug records only in `dev`, while operational info and errors remain available in all modes. The API defaults to the local host and port, and the desktop defaults to the local API. `ELECTRON_RENDERER_URL` is supplied by electron-vite during development; you do not set it yourself.

Backend settings and provider keys belong in Doppler, not `.env`. Copy `.env.example` to
`.env.local` only when overriding the two public desktop settings.

Start the database separately when needed. `pnpm dev` applies existing migrations automatically;
use `db:migrate` when authoring a new migration after editing `schema.prisma`:

```sh
pnpm db:start
doppler run -- pnpm db:migrate
```

`pnpm db:stop` stops the local database while preserving its volume. Always confirm that the saved
Doppler selection points to the intended development database before running a migration.

The development API requires the database to be reachable for migrations. `pnpm dev:desktop` can still run independently. The desktop has no connection-check control; `/health/ready` remains available for operational readiness. `pnpm dev:desktop` downloads a checksum-verified Cua Driver release into Tro's local development cache when needed. On macOS, grant Screen Recording and Accessibility to Tro (Electron during development); the OS cannot grant those automatically. Sign in with Google in the system browser. Chat requires the database and backend model key. The first message starts a local agent worker and a private `cua-driver mcp` connection. Edit `src/desktop/worker/ComputerUseInstructions.ts` to change the agent's standing instruction.

To see the exact schema Cua publishes and the tool parameters produced by the
OpenAI Agents SDK, run `pnpm inspect:cua:mcp browser_click`. Use
`pnpm inspect:cua:mcp --list` to find another tool name. This local command
only reads MCP tool definitions; it does not invoke a desktop action or print
screen contents. If strict conversion cannot preserve Cua's open-object schema,
the output shows `"strict": false` and retains `"additionalProperties": true`.

When the desktop's validated application environment is `dev`, sending a chat
message also emits structured `log.debug` records in the `[desktop]` terminal:
`agent.task.started`, `openai.request`, `openai.response`, `cua.request`,
`cua.response`, and `agent.task.completed` (or a corresponding failure record).
These show model/tool names, argument types, content kinds, counts, status, and
elapsed time. Text typed into apps, chat text, screenshots, model answers,
headers, and tokens are excluded. Stage and production builds do not emit these
debug records. The Agents SDK's separate strict-schema warnings can still
appear; they indicate fallback to a non-strict tool schema.

## Doppler configuration

The Featherlane AI Doppler workplace has two Tro projects: `tro-local` and `tro-api`. `tro-local` owns public Electron settings; `tro-api` owns backend and Prisma settings. Each project has `dev`, `stg`, and `prd` root configs.

| Project     | Variable                 | `dev` value                          | Hosted configuration                           |
| ----------- | ------------------------ | ------------------------------------ | ---------------------------------------------- |
| `tro-local` | `MAIN_VITE_API_BASE_URL` | `http://127.0.0.1:3000`              | Pending: public HTTPS API URL                  |
| `tro-local` | `MAIN_VITE_APP_ENV`      | `dev`                                | `stage` in `stg`; `prod` in `prd`              |
| `tro-api`   | `DATABASE_URL`           | Local PostgreSQL from `compose.yaml` | Pending: environment-specific PostgreSQL URL   |
| `tro-api`   | `APP_ENV`                | `dev`                                | `stage` in `stg`; `prod` in `prd`              |
| `tro-api`   | `HOST`                   | `127.0.0.1`                          | `0.0.0.0`                                      |
| `tro-api`   | `PORT`                   | `3000`                               | Supplied by the hosting platform; default 3000 |
| `tro-api`   | `AUTH_SECRET`            | Unique local secret                  | Unique secret per environment                  |
| `tro-api`   | `AUTH_BASE_URL`          | `http://127.0.0.1:3000`              | Public HTTPS API URL                           |
| `tro-api`   | `GOOGLE_CLIENT_ID`       | Google OAuth web client ID           | Environment-specific OAuth client ID           |
| `tro-api`   | `GOOGLE_CLIENT_SECRET`   | Google OAuth web client secret       | Environment-specific OAuth client secret       |
| `tro-api`   | `OPENAI_API_KEY`         | Server-side key for chat             | Server-side key for chat                       |

Hosted URLs remain unset and appear as missing values in Doppler. Complete them before deploying or packaging a hosted desktop build. `DATABASE_URL` and `AUTH_SECRET` are required backend variables; both Google variables enable sign-in, and `OPENAI_API_KEY` enables chat. The desktop's public API URL must be supplied for hosted builds. Keep the provider credentials in `tro-api` only; never add them to `tro-local`.

With the Doppler CLI installed and signed in, start the local database with `pnpm db:start`, then run the two processes from this repository in separate terminals. The API command applies existing migrations before starting:

```sh
doppler run --project tro-api --config dev -- pnpm dev:api
```

```sh
doppler run --project tro-local --config dev -- pnpm dev:desktop
```

[Doppler injects the selected config into the command's environment](https://docs.doppler.com/docs/secrets-setup-guide). These separate process commands keep database credentials out of the desktop process; `pnpm dev` likewise wraps only the API command with Doppler. The API dev command no longer loads `.env`, so it does not produce a missing-file warning when using Doppler. Set the hosted URL in `tro-local` before running `doppler run --project tro-local --config prd -- pnpm package:desktop`. No Railway sync or service token has been configured; creating Doppler configs alone does not connect a deployment.

Desktop builds suppress only two known `INVALID_ANNOTATION` warnings caused by Zod's explanatory comments mentioning `@__PURE__`. Rollup still removes those comments; dependency code and genuine optimization annotations are unchanged. Other warnings, including other invalid annotations, remain visible.

## Make one feature easy to follow

1. Define its request/response schemas in `src/contracts`.
2. Implement the application workflow using small ports.
3. Put Prisma and providers behind adapters in the owning feature.
4. Add an HTTP route with runtime input validation and backend authorization.
5. Expose a narrow desktop bridge method and update the screen.
6. Finish meaningful tests, migrations, and documentation before final validation.

Prefer `createTryOnJob` over `processRequest`, `canRunAgent` over vague flags, and `TryOnJob.ts` over catch-all helpers. Use your exact naming and spacing rules in AGENTS.md.

## Validation

```sh
pnpm format
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
```

Unit tests need no credentials or database. Integration checks create, migrate, test, and remove a disposable PostgreSQL container, without using `.env` or its database target. Docker must be running. Do not weaken checks or claim tests passed without executing them.

For worker bundling changes, also run `pnpm test:worker` on a machine able to launch Electron. It builds the actual main/worker configuration in development and production modes into temporary directories, then starts the worker in a real Electron utility process and sends a stop command. No agent task, Cua Driver, database or model call is started, no credentials are forwarded to Electron, and the temporary outputs are removed. This check does not overwrite a running development app's `out/` files. It verifies startup, not end-to-end desktop automation.

The main build leaves `ws`'s optional `bufferutil` and `utf-8-validate` requires unconverted via `commonjsOptions.ignore`. Their guarded load can then fall back to JavaScript. Bundling a missing optional peer as a top-level import instead causes development workers to crash before receiving any command; installing a native accelerator is not required for this fallback.

`pnpm db:stop` stops the local development database and preserves its volume. Do not run reset commands against a database containing real data.

## Desktop packaging

Set `MAIN_VITE_API_BASE_URL` to the public HTTPS backend URL before building, then run `pnpm package:desktop` on the target operating system. This is the only desktop API URL setting; Vite embeds it in the build, so changing it requires a new build. The desktop defaults to `dev` during development and `prod` when packaged; set public `MAIN_VITE_APP_ENV=stage` for a staging build. This command does not publish artifacts. Windows and macOS signing, macOS notarization, installer smoke tests, and updater configuration remain release work. Desktop builds contain public settings, never database credentials or shared provider keys.

`build:desktop` bundles the main, local worker, preload, and renderer and writes an isolated `out/package.json`. `package:desktop` stages that output outside the pnpm workspace, downloads the pinned Cua Driver 0.30.4 release for the build platform, verifies its SHA-256 digest, and includes it outside ASAR as an executable resource. This prevents the workspace's backend dependencies from entering the desktop artifact and gives users the driver with Tro's installer. Development caches the same verified release under `~/.cache/tro/cua-driver`. Build installers on each target OS/architecture; macOS carries the driver executable and native SDK as resources; Tro owns the OS grants and directly starts a private embedded daemon. Sign the native libraries and driver before signing/notarizing the enclosing Tro app. Windows carries the native executable. Validate signed/notarized packaging and OS permissions before release. A packaged build does not download driver code on first launch; updates arrive with a new Tro installer.

The app package uses ASAR for JavaScript, while the bundled Cua executable and SDK libraries live inside Tro's physical Resources directory. Packaging checks their presence before signing. There is no separate CuaDriver app to install or authorize. The worker uses a short-lived Tro gateway token and disables SDK tracing. The provider key is backend-only.
