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

The model gateway uses the same API console logger. Under `[api]`, messages explain request dispatch, OpenAI acceptance/rejection, completion, network failures, local credential rejection and interrupted forwarding. Failures include the original provider HTTP status, recognized error code/type, safe schema parameter path, provider request ID and elapsed time. Network failures include known transport codes such as `ECONNRESET` or `ENOTFOUND`, plus timeout/disconnection flags. Unknown error details are marked unavailable; raw provider messages, prompts, tool results, screenshots, tokens, user identifiers and credentials are excluded. No extra logging environment variable is required.

Match `gatewayRequestId` in the desktop's `openai.response` record to the API gateway records. The gateway returns that identifier in `x-tro-request-id`; provider failures retain the existing generic 502 response body. For example, `OpenAI rejected the model request.` with `providerStatus: 400`, `providerErrorCode: invalid_value` and `providerParameter: input[4].content[0].type` identifies an invalid upstream input instead of suggesting a desktop or verification failure. This example is illustrative; it is not a diagnosis of a particular run.

The gateway retries a rejected model fetch once after 250 ms only for `UND_ERR_SOCKET`, `ECONNRESET` or `EPIPE`. Both attempts share the original cancellation/deadline and request body. The removed daily model quota is not restored. `model.gateway.retry` explains recovery. HTTP errors, other network errors and failures after response headers are not retried. The SDK still disables its own automatic retries, and no desktop tool is replayed. A broken connection leaves provider execution uncertain, so a retry can incur another inference charge; this is bounded recovery, not an exactly-once guarantee.

Cua diagnostics recognize the pinned driver's nested `refusal.code`, browser binding/setup/consent codes and focus/window codes. Focus results report only supplied boolean flags such as `request_accepted`, `process_activated`, `focused` and `front_in_process_on_display`, excluding titles and raw messages. Response counters reflect the post-call task state; `recordedObservationCount` reports new captures from that call separately from the retained observation count.

Teaching failures emit an error-level `agent.teaching.failed` record in the desktop
console before the public result is reduced to its guidance reason. The record
identifies the failed stage and precise local error code. In particular,
`observation_ready_timeout` means watch admission succeeded but no usable native
frame became ready within 10 seconds. It includes the owned error message and
stack, elapsed time, poll count, and last validated observation metadata, excluding
the watch ID. It does not establish why ScreenCaptureKit produced no usable frame.
Native tool errors, invalid snapshots, foreign watch snapshots, and missing model
capture baselines have distinct diagnostics. Failed host calls log at error level;
successful routine metadata polls remain quiet. Esc is cancellation and emits no
teaching failure record. Operational worker errors remain enabled outside dev.
Arbitrary SDK exception messages and raw payloads are excluded because they can
contain prompts, screen content, tokens, or credentials.

Backend settings and provider keys belong in Doppler, not `.env`. Copy `.env.example` to
`.env.local` only when overriding the two public desktop settings.

The model gateway has no per-account or daily model request cap. Authenticated requests
are forwarded regardless of previous request counts, and Tro no longer increments the
historical `ModelUsage` records. Existing records and applied migrations are preserved.
Idle cursor following does not make model requests. OpenAI's own provider limits may
still apply.

Start the database separately when needed. `pnpm dev` applies existing migrations automatically;
use `db:migrate` when authoring a new migration after editing `schema.prisma`:

```sh
pnpm db:start
doppler run -- pnpm db:migrate
```

`pnpm db:stop` stops the local database while preserving its volume. Always confirm that the saved
Doppler selection points to the intended development database before running a migration.

The development API requires the database to be reachable for migrations. `pnpm dev:desktop` can still run independently. The desktop has no connection-check control; `/health/ready` remains available for operational readiness. `pnpm dev:desktop` downloads a checksum-verified Cua Driver release into Tro's local development cache when needed. On macOS, grant Screen Recording and Accessibility to Tro; the OS cannot grant those automatically. Sign in with Google in the system browser. Chat requires the database and backend model key. The first message starts a local agent worker and a private `cua-driver mcp` connection. Edit `src/desktop/worker/agent/ComputerUseInstructions.ts` to change the agent's standing instruction.

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

Teaching finalization emits `agent.teaching.settled` with the host task ID,
validated reply purpose, outcome, reason, answer presence and duration. This
distinguishes a question from a guide without receipts without logging the
answer itself.

For Show me, the first model request selects `get_desktop_state` explicitly.
Expect `openai.response` to list that tool, followed by its `cua.request` and
`cua.response`, then another model request containing the screenshot and capture
metadata. A visual tour subsequently calls `show_cursor_sequence`; an
`agent.teaching.settled` outcome of `demonstrated` requires a validated native
receipt; prose-only replies cannot settle as successful guidance. A live model check is still needed for cue choice and placement.

Before each grounded `show_cursor_sequence`, the host calls the private native
`refresh_cursor_guidance_capture` tool. `cua.guidance.capture_refreshed` reports
capture age, comparison duration and a safe `validationReason`. Stable target
regions renew the capture ID despite unrelated animation; changed targets and
geometry refuse playback. This local comparison returns no image to the model.
Input and geometry are checked before and after comparison. Native comparison
errors produce an error-level `cua.guidance.refresh_failed` with
`capture_refresh_failed`, and abort the SDK segment without a model retry.
Screen bytes and capture IDs stay out of logs. Native guidance reasons such as
`target_invalidated`, `invalid_request` and `render_timeout` appear as recognized
`reasonCode` values in `cua.response`.

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

On macOS, `pnpm dev:desktop` and `pnpm start:desktop` launch a checkout-owned `.tro-development/Tro.app` with Tro's icon and display name. `scripts/PrepareDesktopDevelopmentHost.ts` copies the pinned Electron runtime, applies the committed icon and microphone purpose, and signs only that local copy ad hoc. The dependency in `node_modules` remains intact. The host is reused until its Electron version, artwork or purpose changes; quit Tro before rebuilding it. `pnpm exec tsx scripts/StartDesktop.ts --prepare-only` prepares the host without launching the app or requesting permissions.

The development bundle ID is `app.tro.desktop.development`; installed Tro remains `app.tro.desktop`. macOS grants are separate, and the first branded development launch needs its own grants. Direct `electron-vite` launches still use Electron's identity. No existing Settings entries or grants are removed. The native host receives the matching identity so permission checks remain tied to the actual app. The packaged ICNS supplies the icon in Finder and macOS permission dialogs; runtime Dock changes alone do not change the OS permission identity.

Set `MAIN_VITE_API_BASE_URL` to the public HTTPS backend URL before building, then run `pnpm package:desktop` on the target operating system. This is the only desktop API URL setting; Vite embeds it in the build, so changing it requires a new build. The desktop defaults to `dev` during development and `prod` when packaged; set public `MAIN_VITE_APP_ENV=stage` for a staging build. This command does not publish artifacts. Windows and macOS signing, macOS notarization, installer smoke tests, and updater configuration remain release work. Desktop builds contain public settings, never database credentials or shared provider keys.

`build:desktop` bundles the main, local worker, preload, and renderer and writes an isolated `out/package.json`. `package:desktop` stages that output outside the pnpm workspace, downloads the pinned Cua Driver 0.30.4 release for the build platform, verifies its SHA-256 digest, and includes it outside ASAR as an executable resource. This prevents the workspace's backend dependencies from entering the desktop artifact and gives users the driver with Tro's installer. Development caches the same verified release under `~/.cache/tro/cua-driver`. Build installers on each target OS/architecture; macOS carries the driver executable and native SDK as resources; Tro owns the OS grants and directly starts a private embedded daemon. Sign the native libraries and driver before signing/notarizing the enclosing Tro app. Windows carries the native executable. Validate signed/notarized packaging and OS permissions before release. A packaged build does not download driver code on first launch; updates arrive with a new Tro installer.

The app package uses ASAR for JavaScript, while the bundled Cua executable and SDK libraries live inside Tro's physical Resources directory. Packaging checks their presence before signing. There is no separate CuaDriver app to install or authorize. The worker uses a short-lived Tro gateway token and disables SDK tracing. The provider key is backend-only.

## Companion driver build

Run `pnpm build:cua` before testing native cursor guidance on macOS. It builds
the pinned companion patch into the same embedded executable layout used by
Tro’s standard driver, with its runtime libraries and build metadata under
`~/.cache/tro/cua-companion`. Development prefers a valid companion cache over
the standard release cache; packaged resources take precedence over both.
Tro’s main process owns the native host, permission checks and private endpoint
for both idle following and credentialed tasks. Enable Tro in System Settings;
the standard development launcher uses a separate Tro development identity. Rebuild an older companion cache
with this command before restarting the desktop.

### Teaching click continuation smoke check

After rebuilding the native companion (`pnpm build:cua`) and restarting Tro,
select Show me and ask to open YouTube. Follow a browser-icon cue with a real
click, including a click before the preview finishes or while the model composes
its reply. Tro should observe the browser and cue its address bar in the same
request. Enter youtube.com, press Enter, and confirm the next observation can
finish the lesson. The chat shows each current instruction during input waiting.
Move the pointer without clicking: this must not advance the lesson. Press Esc while the browser is in front, or click the workspace Esc control
while waiting: no later cue or instruction may appear. An unchanged screen remains in local waiting without another model request;
there is no sixty-second lesson timeout. This live check uses
model requests and is separate from synthetic unit/integration validation.
