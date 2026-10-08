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
| HUD narration                               | Backend-only `ELEVENLABS_API_KEY`; locale/voice mapping belongs in [VoiceoverConfig.ts](src/server/features/voiceover/VoiceoverConfig.ts).                                                                     |
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
selected native tests, builds/signs the local executable and records checksums in
`~/.cache/tro/cua-companion`. Restart the desktop after rebuilding so its daemon
loads that executable. [CuaCompanionBuild.ts](src/contracts/CuaCompanionBuild.ts)
owns the required version/source commit. Packaged driver resources take precedence
over development caches.

The macOS launcher uses the checkout-owned `.tro-development/Tro.app`. Quit it
before rebuilding its static host. The development bundle has a separate identity
from installed `app.tro.desktop`; grant each its own Screen Recording, Accessibility
and microphone access when requested. The launcher preserves saved accounts and
OS grants. Keep the same app instance open throughout browser OAuth. If a different
checkout owns the callback, restart the intended launcher before signing in.

Choose **Show me** for student-controlled guidance and **Do it for me** for general
execution. Joined classroom tasks admit Show me only. Voice holds Command + Control
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
joined Practice activity, Cmd/Ctrl + Shift + Enter opens evidence review; the button
and in-app shortcut remain fallbacks. Check selected evidence, inspect feedback,
request a hint or targeted Show me, then independently confirm hand-in. Confirm
teacher results show the exact saved evidence/version. A live class must end before
confirmed deletion. Class deletion preserves work/history; removing a material
preserves originals referenced by approved revisions.

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
