# Tro

Electron + React desktop, strict TypeScript API and Prisma/PostgreSQL persistence.
Tro supports authenticated computer use, student-controlled teaching, classroom
materials, voice input and a native macOS companion.

Read [Architecture](docs/Architecture.md) for the current system, component
communication, ownership and limits. It is the single maintained architecture
document. This README owns setup, commands and release checks. [AGENTS.md](AGENTS.md)
owns repository coding rules. [Research](research/TeachingPainPoints.md) and
[visual prototypes](examples/previews/ClassroomExperienceDemo.html) are reference
material; they do not define current runtime behavior.

## Start locally

Use Node.js 24 LTS, pnpm 11, Docker and the Doppler CLI. From this standalone root:

```sh
pnpm install
pnpm db:start
doppler login
pnpm select
pnpm dev
```

At `pnpm select`, choose the backend `tro-api` project and intended development
config. `pnpm dev` injects that configuration into the API only; it applies committed
migrations and generates Prisma before startup. It launches the desktop without
backend secrets. Ctrl-C stops both processes. The API defaults to
`http://127.0.0.1:3000`; local PostgreSQL uses port 54329.

For separate terminals, with the corresponding configs selected:

```sh
doppler run --project tro-api --config dev -- pnpm dev:api
```

```sh
doppler run --project tro-local --config dev -- pnpm dev:desktop
```

`pnpm db:stop` preserves the development database volume. Never reset a database
containing real data. `pnpm db:migrate` authors a new reviewed migration;
`pnpm db:deploy` applies existing ones. Integration tests use their own disposable
container, not the development database.

## Configuration

| Process                                     | Settings                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                                     | `DATABASE_URL` and unique `AUTH_SECRET` are required. `APP_ENV=dev                                                                                                                                             | stage | prod`, `HOST`, `PORT`and`AUTH_BASE_URL` select the API environment/address. |
| Google sign-in                              | Backend-only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Register the web OAuth redirect as `AUTH_BASE_URL + /api/auth/callback/google`; local default is `http://127.0.0.1:3000/api/auth/callback/google`. |
| Chat, transcription, materials and practice | Backend-only `OPENAI_API_KEY`. Feature budgets and settings are validated in [server Env.ts](src/server/Env.ts) and owning config modules. The API can start with provider features unavailable.               |
| HUD narration                               | Backend-only `OPENAI_API_KEY` (shared with other OpenAI features); speech model, instructions and locale/voice mapping belongs in [VoiceoverConfig.ts](src/server/features/voiceover/VoiceoverConfig.ts).      |
| Desktop                                     | Public `MAIN_VITE_API_BASE_URL` and `MAIN_VITE_APP_ENV`. Local defaults work without overrides; `.env.local` may override these public values. `ELECTRON_RENDERER_URL` is supplied by electron-vite.           |
| Installed updates                           | Public build-time `MAIN_VITE_UPDATE_FEED_URL`, an HTTPS release directory. Unset disables updates.                                                                                                             |

Keep backend credentials in `tro-api`, never `tro-local` or Electron. T3 Env modules
validate runtime values; they do not inject secrets. JSON file configuration is
validated separately. Check the selected Doppler config before any migration.
Hosted URLs and secrets must be configured explicitly; this checkout does not
create cloud resources or deploy automatically.

## Desktop and native companion

```sh
pnpm build:cua
pnpm dev:desktop
```

`build:cua` fetches the pinned Cua source, applies `CursorCompanion.patch`, runs
companion, MCP transport and session tests, builds/signs the local executable and
records checksums in `~/.cache/tro/cua-companion`. Restart the desktop after
rebuilding so its daemon loads that executable.
[CuaCompanionBuild.ts](src/contracts/CuaCompanionBuild.ts)
owns the required version/source commit. Packaged driver resources take precedence
over development caches.

To measure desktop memory on macOS, use Tro's main process PID from Activity
Monitor (replace `12345` below):

```sh
pnpm check:desktop-memory --pid 12345 --duration-seconds 60
```

The read-only check reports physical footprint for main and all current helper
processes, including compressed/swapped allocations. It reports growth and whether
the combined footprint is below a 1 GB idle target. Measure after startup settles
and again during the intended workload; the target is not a guaranteed ceiling
for active teaching, media playback or development tooling. The API, database and
other applications are outside this desktop process tree. The check never restarts
Tro or starts an agent/model request.

The macOS launcher uses the checkout-owned `.tro-development/Tro.app`. Quit it
before rebuilding its static host. The development bundle has a separate identity
from installed `app.tro.desktop`; grant each its own Screen Recording, Accessibility
and microphone access when requested. The launcher preserves saved accounts and
OS grants. Keep the same app instance open throughout browser OAuth. If a different
checkout owns the callback, restart the intended launcher before signing in.

Choose **Show me** for student-controlled guidance and **Do it for me** for general
execution. Show me uses model-supplied scribble strokes and requires the matching
native build; old teaching drawing protocols are not supported. Joined classroom
tasks admit Show me only. Voice holds Command + Control
on Mac or Control + Left Alt on Windows; release submits one final transcript.
Microphone selection/ranking/comparison is in Settings. Narration and bundled pets
are optional. Model requests, transcription and provider narration may incur charges.

To inspect tool schemas without performing desktop actions:

```sh
pnpm inspect:cua:mcp --list
pnpm inspect:cua:mcp browser_click
```

## Classroom pilot

Apply committed migrations through normal startup. Accounts default to Student;
a backend operator can grant/revoke a role by verified email:

```sh
doppler run -- pnpm account:role teacher@example.com teacher
```

Use `student` to revoke teacher access. Sign in as the teacher, create a class,
upload materials, prepare/review and approve an immutable publication. Enroll a
student who has signed in or provide an invitation code. Start a session and select
its section, stage and pacing. Sign in as an enrolled student and explicitly join.
Account switching permits sequential teacher/student checks on one device; it does
not establish simultaneous two-device behavior.

Enable and approve a practice checkpoint before testing **Check my work**. In a
joined Practice activity, choose a work window, then use **Check current window**,
Command + K on macOS, or Alt + K on Windows to capture and review it. Captures stay
local until **Check my work**. macOS requires Screen Recording permission; reopen Tro
after changing that permission if necessary. Manual text/code, PNG/JPEG, PDF and sb3
uploads are also supported within the [evidence limits](src/contracts/PracticeCheck.ts).
PDF checking reads text; Scratch checking reads structure without running the project.
The HUD shows localized checking and feedback status when voice/teaching is idle;
the practice panel always shows request progress. On macOS, an idle native HUD shows
**⌘ K · Check work** (**Kiểm tra bài**) when an approved Practice task and the global
shortcut are available. The hint opens capture/review; hand-in still needs confirmation. Inspect feedback,
request a hint or targeted Show me, then independently confirm hand-in. Confirm
teacher results show the exact saved evidence/version. A live class must end before
confirmed deletion. Class deletion preserves work/history; removing a material
preserves originals referenced by approved revisions.

Classroom learning insights are always on. Select **Insights** in the navbar
(**Tiến độ học tập** in Vietnamese), then choose a class to view student journeys,
class summaries and teacher reports. Access follows class ownership/enrollment.
Collection records accepted classroom work; historical work is not imported
implicitly. Backend collection and retention settings live in
[Env.ts](src/server/Env.ts), with 180-day retention by default.

## Validation

Finish all related edits, then run the required checks:

```sh
pnpm format
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
```

Unit tests require no credentials or live database. Integration tests need Docker
and create/migrate/remove a disposable PostgreSQL container. Run
`pnpm test:worker` for worker bundling/startup changes. These checks use local
fixtures and do not call a paid provider.

For worker, SDK, preload, teaching or gateway wiring:

```sh
pnpm test:teaching
```

For model gateway diagnostics, run the real-socket failure lab:

```sh
pnpm test:model-gateway
```

It uses synthetic requests and loopback servers, with no credentials or paid model
call. Safe event logs and the case report are written to
`.tro-development/model-gateway-diagnostics/GatewayEvents.jsonl` and
`GatewayReport.json`. During `pnpm dev`, match `modelRequestId` between the worker's
`openai.request`/`openai.response` and API `model.gateway.*` events. Use
`gatewayRequestId` for the API request, `attemptNumber` for retries, and
`taskId`/`lessonId` to reach teaching and HUD events. See
[Architecture.md](docs/Architecture.md#agent-requests-and-model-gateway) for what
each failure stage establishes.

For current provider connectivity, run credentialless DNS/TLS/HTTP probes in the
same environment as the API:

```sh
pnpm check:model-connection
doppler run -- pnpm check:model-connection
```

The report is `.tro-development/model-connection/ConnectionReport.json` (each run
replaces it). Probes send only GET requests without credentials or inference.
They compare repeated native fetch with fresh IPv4/IPv6 HTTPS sockets and record
proxy/CA presence, safe TLS state, timing and IDs. A 401 is the expected reachable
response. Small GET success does not prove screenshot uploads are stable. Forced
IPv6 failure alone does not explain a successful default IPv4 connection. The
fresh HTTPS and fetch paths can use different proxy routes.

Each gateway attempt also sends a unique `providerClientRequestId` as
`X-Client-Request-Id`. Match that ID across attempt events and the final error
envelope; provider support can use it when a disconnect leaves no response ID.
Inspect `socketFailure` in a failed attempt or final `model.gateway.failed` event
alongside `networkCode`: it preserves an observed TLS/socket cause even when fetch
reports only a later generic disconnect. Console logs from the running API are
separate from the synthetic failure lab's saved `GatewayEvents.jsonl`.

For native watch, capture, input or rendering changes, rebuild first, then run on
an authorized macOS desktop:

```sh
pnpm build:cua
pnpm test:teaching:native
```

The native contract requires a validated completion marker and checks two-message
HUD installation under stale refresh/renewal/speaking, token-conditioned clears,
lesson changes, paired drawing receipts, capture isolation and teardown. Exit zero
alone is insufficient. It does not inject physical input or prove physical scan-out.

## Packaging and hardware checks

Set the public HTTPS API URL before `pnpm package:desktop` on the target OS. Keep
provider/database secrets out of that command. The package stages the native driver,
SDK, native hook prebuilds and microphone entitlement. macOS updates need the ZIP
and metadata as well as the DMG installer; Windows uses NSIS and its update metadata.
Set the HTTPS update feed during the same build/package invocation. Development
updates remain disabled. Signing/notarization and distribution require a separate
reviewed release; ad hoc local signing is not release signing.

### Windows release from GitHub Actions

The **Windows Release** workflow builds a signed x64 NSIS installer from `main`
when manually dispatched. It validates the project without cloud credentials,
then uses the GitHub environment `release` and Azure OIDC to sign during packaging.
It uploads verified build artifacts for 14 days; it does not publish a GitHub
Release, deploy the API, or provision an update feed. No separate release branch
or client secret is needed.

Before the first run, restrict the repository's `release` environment deployment
branches to `main`, confirm the Azure Public Trust certificate profile is Active,
and assign **Artifact Signing Certificate Profile Signer** to the app service
principal on the signing account. Assigning it only to your personal user does not
authorize Actions. The app's federated credential must have issuer
`https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`
and a subject matching this repository and the `release` environment. New GitHub
repositories use immutable owner/repository IDs in that subject; copy the full
value from your federation setup instead of using an older names-only example.

Configure these **environment variables** under repository Settings → Environments
→ release. These are public settings/identifiers; never place provider credentials
or Azure tokens in a `MAIN_VITE_*` variable.

| Variable                    | Value                                                    |
| --------------------------- | -------------------------------------------------------- |
| `AZURE_CLIENT_ID`           | Application (client) ID for the signing app registration |
| `AZURE_TENANT_ID`           | Directory tenant ID                                      |
| `AZURE_SUBSCRIPTION_ID`     | Subscription containing the signing account              |
| `AZURE_SIGNING_ENDPOINT`    | Signing account's regional HTTPS endpoint                |
| `AZURE_SIGNING_ACCOUNT`     | Artifact Signing account name                            |
| `AZURE_CERTIFICATE_PROFILE` | Active Public Trust profile name                         |
| `AZURE_SIGNING_PUBLISHER`   | Exact certificate common name (CN), including name order |
| `MAIN_VITE_API_BASE_URL`    | Public production HTTPS API URL; required, no localhost  |
| `MAIN_VITE_UPDATE_FEED_URL` | Optional public HTTPS generic update feed                |

The workflow supplies `MAIN_VITE_APP_ENV=prod` and `TRO_SIGN_WINDOWS=true`. Ordinary
local packaging keeps signing optional. Source version comes from committed
`package.json`; change it through normal review before producing a new version.
Azure signing settings stay in the packaging process and are not copied into app
metadata. The pinned electron-builder v26 uses `win.azureSignOptions`; its upstream
PowerShell signing module and hosted runner image are not completely pinned by
the pnpm lockfile.

After the workflow is merged into `main`, open Actions → Windows Release → Run
workflow → main. Download the successful run's `Tro-windows-x64-…` artifact. It
contains `Tro-<version>-windows-x64-setup.exe`, its blockmap, a signature inventory,
and update metadata when a feed is configured. Signing failures or invalid
signatures prevent upload. The verifier checks all loose Windows PE executables,
DLLs and native addons, preserving valid vendor signatures where the builder has
not already signed them. The main app and installer must match the configured
publisher and have a trusted timestamp. Non-Windows native prebuilds are excluded
by their file header, not merely their extension.
Each new signing result is also verified before packaging continues, including
the temporary NSIS uninstaller before it is embedded and deleted by the builder.

To verify a locally packaged signed Windows build with the expected publisher set:

```powershell
./scripts/VerifyWindowsRelease.ps1 -Directory release
./scripts/VerifyWindowsRelease.ps1 -Mode Test
```

With a configured feed, also pass `-RequireUpdateMetadata`; `latest.yml` must exist
and its hashes and size must match the final signed installer. The verifier accepts
the pinned builder's single-file YAML layout for this x64 target and fails if the
layout changes. It reports the manifest name and mismatch category without dumping
its contents. Builder diagnostic files such as `builder-debug.yml` are excluded
from update verification and artifact upload. Any `latest.yml` present is checked
even when the feed is unset.
Without a feed, updates remain disabled. Actions artifacts are not a public update
server. Never modify or re-sign installer bytes after generating update metadata.

For OIDC login errors, compare the full subject, issuer and audience. For signing
403 errors, check the app service principal's signer role and allow role changes
to propagate. Publisher mismatches require the certificate's exact CN. Timestamp
or trust failures require checking the reported signing/network stage rather than
falling back to unsigned output. Missing Cua/addon files are packaging failures.
Azure configuration and actual signing must be verified in a real Windows run;
offline tests do not prove that authorization works.

Before public distribution, perform the Windows hardware checks below and inspect
the installed uninstaller's signature on a disposable Windows machine. Confirm
install, launch and uninstall, and test a signed older-to-newer update when a feed
is enabled. Windows teaching parity with the patched macOS companion is not
established by this workflow. Signing identifies the publisher; it does not
guarantee a SmartScreen warning will never appear.

After building, use the local artifact probes where applicable:

```sh
pnpm check:pet-presentation
pnpm check:microphone-package -- /absolute/path/to/unpacked/app
```

Before a signed macOS/Windows release, perform these manual checks:

- Complete Google callback/session restoration, add/switch/sign out accounts, and
  verify stale callbacks cannot select another account or receive another user's data.
- Test held shortcuts, both-release rearming, AltGr on Windows, background recording,
  cancel/close/sleep/lock, fast release while connecting and final transcription once.
- Test USB/Bluetooth/built-in microphones, unplug an explicitly selected device,
  change OS default routing, compare locally, cancel tests and verify tracks stop.
- Ask Show me to open YouTube: follow its browser/address-bar cues with real input,
  include input during a preview/model turn, wait through loading, and verify the
  original goal against the visible result. Passive movement must not advance it.
  Esc during waiting/thinking must prevent later guidance.
- Exercise native cue position, click/drag interruption, focus and display scaling.
  Synthetic receipts do not establish these physical behaviors or model quality.
- Test pet click-through padding, drag/release/cancel, focus, fullscreen/OS menus,
  monitor changes, hide, account changes and restart on both operating systems.
- Install a signed older build and test a signed update: availability, failure/retry,
  explicit download, busy restart blocking, relaunch/version, saved sessions and Cua
  resources. Normal quit must not silently install the update.
- Review real-provider material quality/citations, approved-source retrieval, narration
  pronunciation/cancellation, practice findings and two-device classroom authority.

Record actual results at handoff. Source builds and synthetic tests do not establish
signed hardware, live-provider quality or a hosted production release.

## Backend deployment

Railway is the initial target; deployment requires explicit authorization. The
Dockerfile contains the API, not Electron. Supply the intended database/auth/Google/
provider settings and public HTTPS `AUTH_BASE_URL`. The container binds `0.0.0.0`;
Railway supplies `PORT` or the API default applies. The reviewed pre-deploy step
uses Prisma `migrate deploy`; never use schema resets or `migrate dev` in production.
`/health/live` reports process availability; `/health/ready` requires the migrated DB.

The ingress must support WebSocket upgrades on `/api/v1/transcription/stream`, retain
authentication and permit a full bounded capture. Desktop production uses HTTPS/WSS.
Validate database TLS, backups/recovery, session restoration, provider allowances,
billing/abuse controls and release artifacts before a paid public deployment.
AWS migration and try-on generation are outside the implemented runtime.
