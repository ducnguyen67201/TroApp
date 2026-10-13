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
backend secrets. Before building or starting services, a new `pnpm dev` stops prior
Tro API/desktop development launchers and their descendants from this checkout,
including orphaned watchers. Ctrl-C stops the current native process trees, even
during startup. PostgreSQL and renderer containers stay running. The API defaults to
`http://127.0.0.1:3000`; local PostgreSQL uses port 54329.

If startup fails before service output, `development.startup.failed` reports the
failed stage and a safe reason. It excludes command arguments, environment values
and raw child-process errors, which can contain credentials.

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

## Lesson video development

`pnpm dev` (or `doppler run -- pnpm dev`) starts the lesson rendering worker
through Docker Compose, then launches the API and desktop natively. Keep your
existing development database running; use `pnpm db:start` on a fresh setup.
The launcher does not recreate or replace an existing database container.
The first renderer image build installs Chromium and FFmpeg and can take several
minutes. The development launcher creates a local renderer credential in ignored
`.tro-development/LessonRendererSecret`; only the API and renderer receive it.
Desktop children receive OS settings without backend Doppler credentials.
A renderer startup failure does not prevent the native app from starting; check
Docker output when video creation is unavailable. Ctrl-C stops the native process trees;
use `docker compose stop lesson-renderer` to stop the local renderer.

- `pnpm dev:renderer`: rebuild/start only the local renderer after template edits.
- `pnpm build:renderer`: build the production renderer image without starting it.
- `pnpm check:lesson-renderer`: render synthetic Vietnamese fixtures and combine
  them using the local renderer; no paid model or speech calls.

`pnpm dev:renderer` leaves the running native API and desktop in place; it skips the
normal launcher's replacement of prior native development processes.

After updating the worker's animation runtime, rebuild its image with
`pnpm build:renderer`, then restart `doppler run -- pnpm dev`. Alternatively,
`pnpm dev:renderer` rebuilds and starts the local worker independently. Custom
animation requires the new worker capability; an older baseline-only worker
continues rendering standard animations.

For separate API startup, set `LESSON_RENDER_URL=http://127.0.0.1:3010` and supply
`LESSON_RENDER_SECRET` from the local credential file through your shell or secret
manager. The API and renderer must share this credential to authenticate render
requests. Do not commit it. The development launcher supplies both automatically.
All model choices, allowances and retry limits live in
[LessonVideoConfig.ts](src/server/config/LessonVideoConfig.ts), exported by the
existing config index. Normal tests do not require provider credentials.

On Railway, deploy the existing API Dockerfile and a separate private service using
`Dockerfile.renderer`. Set the API's `LESSON_RENDER_URL` to the renderer's private
HTTP address on port 3010. Set the same generated `LESSON_RENDER_SECRET` on both
services and use `APP_ENV=stage` or `APP_ENV=prod` on the API. Keep the renderer
private, supply no model/database keys to it, and apply
reviewed migrations with `pnpm db:deploy` before updating the API. Start with one
renderer instance and at least the locally tested memory allocation; benchmark
before increasing concurrency. Renderer containers store temporary files only;
PostgreSQL owns saved content, animation source and media. Deploy matching API and
worker builds together so the worker advertises the animation runtime expected by
the API. The API falls back to standard animation when that capability is absent.

The teacher selects prepared/published class material, describes the desired
explanation and creates a video. The writer saves baseline screens, narration and
optional animation ideas first. At most two scenes receive custom animation;
remaining scenes use maintained Remotion layouts. A separate bounded model request
writes each selected animation. Code is saved before execution, and retries and
repairs share the same saved allowance. There is no AI reviewer or layout critic.

The reviewed policy reserves up to two writer requests and two requests for each
of two custom scenes: 48K input and 24K output tokens, or $0.144 USD at the committed
text-model rates. These are configured reservations, not measured average usage;
speech and rendering are separate. See the owning
[configuration](src/server/config/LessonVideoConfig.ts) for models and limits.

Saved screens/transcript remain available before media finishes. Missing or
unfinished optional animation degrades to standard animation; a successfully
rendered video remains ready with a note. A speech failure produces narration text
on that screen. Continue reuses a saved script and source; if the writer was
interrupted before saving content, it may use only its original remaining attempt.
Navigation, edits and Continue never renew model allowances. Edits preserve
unchanged scenes; changed content or narration timing uses standard animation
without another automatic coder request. New content requests create independent
jobs with fresh daily allowance. Add missing narration uses only the remaining
speech allowance.

Continue preserves cumulative renderer attempts. New jobs may use one explicit,
saved media recovery after the original attempts are exhausted; the action becomes
unavailable after that allowance is consumed. Legacy jobs without that policy
retain their original ceiling. A lost creation response keeps the request ID for
safe retry; a confirmed response lets the next submission create a fresh job.

Generated scene code runs in an isolated QuickJS/WASM child, producing validated
SVG data for trusted Remotion components. It does not run in Electron or Chromium.
Source artifacts remain private to the API/worker; the desktop receives status and
MP4 media rather than executable code.
Confirmed provider quality, real cost and hosted throughput still require a
separately authorized paid benchmark; offline fixtures do not establish those.

## Configuration

| Process                                     | Settings                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                                     | `DATABASE_URL` and unique `AUTH_SECRET` are required. `APP_ENV` (`dev`, `stage` or `prod`), `HOST`, `PORT` and `AUTH_BASE_URL` select the API environment/address.                                             |
| Google sign-in                              | Backend-only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Register the web OAuth redirect as `AUTH_BASE_URL + /api/auth/callback/google`; local default is `http://127.0.0.1:3000/api/auth/callback/google`. |
| Chat, transcription, materials and practice | Backend-only `OPENAI_API_KEY`. Feature settings are validated in [backend config](src/server/config/Index.ts). The API can start with provider features unavailable.                                           |
| HUD narration                               | Backend-only `OPENAI_API_KEY` (shared with other OpenAI features); speech model, instructions and locale/voice mapping belongs in [VoiceoverConfig.ts](src/server/config/VoiceoverConfig.ts).                  |
| Desktop                                     | Public `MAIN_VITE_API_BASE_URL` and `MAIN_VITE_APP_ENV`. Local defaults work without overrides; `.env.local` may override these public values. `ELECTRON_RENDERER_URL` is supplied by electron-vite.           |
| Installed updates                           | Public build-time `MAIN_VITE_UPDATE_FEED_URL`, an HTTPS release directory. Unset disables updates.                                                                                                             |

Keep backend credentials in `tro-api`, never `tro-local` or Electron. T3 Env modules
validate runtime values; they do not inject secrets. JSON file configuration is
validated separately. Check the selected Doppler config before any migration.
Hosted URLs and secrets must be configured explicitly; this checkout does not
create cloud resources or deploy automatically.

Reviewed settings for classroom insights, practice, materials and HUD voiceover live
in `src/server/config/`, exported by `Index.ts`. Credentials remain in `Env.ts`.

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

### What’s new

Open **What’s new** (**Có gì mới**) beside Settings to replay the installed release’s
highlights. It is also available on the welcome screen. The first launch establishes
a local baseline; later updates with new highlights show the tour once, after
sign-in, permission setup and active work have settled. Closing counts as viewed.
The amber dot clears when viewed. Seen state belongs to this installation, works
offline and is shared by accounts using it.

When preparing a release, add localized highlights to
[ReleaseNotes.ts](src/desktop/updates/ReleaseNotes.ts) with the shipped `package.json`
version. Keep newest entries first. Builds without new highlights need no new entry
and retain earlier notes for manual replay. Do not bump the app version merely to
edit preview content. For acceptance, launch an older version to establish a
baseline, update to a newer build with notes, verify one automatic tour when idle,
close and relaunch, then reopen it through the permanent entry. Confirm a fresh
installation and a patch without notes do not interrupt startup.

## Onboarding and recordings

After sign-in, Tro offers a short six-step tour when the interface is idle and ready.
Students and teachers receive role-specific explanations. Skip/close suppresses
future automatic offers; an interrupted tour resumes at its saved step. Use
**Settings → General → Restart onboarding** (**Cài đặt → Chung → Bắt đầu lại hướng dẫn**)
to replay it. Progress belongs to the selected account on this device; changing
language or updating a recording does not reset it. Reset changes only onboarding.

The Guided Lessons step remains as a coming-soon preview while its runtime is being rebuilt.

### Add or replace a recording

There is currently no in-app upload screen. Copy your recordings into this
checkout before building the desktop. Five Vietnamese AI-narrated clips are included for students: classes, insights,
guided lessons, microphone and pets. Microphone and pet clips also serve teachers.
Teacher classroom steps and Workspace use written explanations until recordings
for those audiences are added.

**Filenames must match exactly, including capitalization and the lowercase `.mp4`
extension.** Rename your exported file to one of the names below. The mapping is
owned by [OnboardingContent.ts](src/desktop/renderer/onboarding/OnboardingContent.ts);
an unrecognized filename will not appear in the tour.

| Navbar panel                         | Audience              | Exact video filename       |
| ------------------------------------ | --------------------- | -------------------------- |
| Workspace / Không gian làm việc      | Students and teachers | `Workspace.mp4`            |
| Classroom / Lớp học                  | Students              | `StudentClasses.mp4`       |
| Classroom / Lớp học                  | Teachers              | `TeacherClasses.mp4`       |
| Insights / Tiến độ học tập           | Students              | `StudentInsights.mp4`      |
| Insights / Tiến độ học tập           | Teachers              | `TeacherInsights.mp4`      |
| Guided lessons / Bài giảng hướng dẫn | Students              | `StudentGuidedLessons.mp4` |
| Guided lessons / Bài giảng hướng dẫn | Teachers              | `TeacherGuidedLessons.mp4` |
| Microphone / Micrô                   | Students and teachers | `Microphone.mp4`           |
| Settings → Pets / Cài đặt → Thú cưng | Students and teachers | `Pets.mp4`                 |

1. Create `src/desktop/assets/onboarding/vi/` if it does not exist, then copy your
   Vietnamese clips there using the exact filenames above. For example, rename
   `my-workspace-intro.mp4` to `Workspace.mp4` and place it directly in that folder.
2. Optionally add supporting files beside each clip, using the same name before
   the extension:

   | Example file    | Purpose                        |
   | --------------- | ------------------------------ |
   | `Workspace.png` | Poster shown before playback   |
   | `Workspace.vtt` | Captions in WebVTT format      |
   | `Workspace.txt` | Transcript as UTF-8 plain text |

   Each is independently optional. An absent or blank `.txt` file hides the
   transcript control. Captions do not automatically create a transcript.

3. Build the desktop after adding or replacing files:

   ```sh
   pnpm build:desktop
   ```

   Relaunch the desktop and use **Settings → General → Restart onboarding** to
   review the clips. Changing a recording alone does not reset saved progress.
   Installed users receive new recordings through a rebuilt desktop package.

Keep clips short and compatible with Electron's video player; review playback,
captions and package size in the packaged app. Renaming another video format to
`.mp4` does not convert it. Videos require a click to play and never automatically
advance the tour. No provider calls or media generation are involved.

### English recordings and missing media

Add English clips under `src/desktop/assets/onboarding/en/` using the same exact
filenames. Supporting files also belong in their language's folder. For example,
`vi/Workspace.mp4` and `en/Workspace.mp4` are two recordings for the same panel.
You can add English clips later without changing the mapping or resetting progress.

The app's selected language chooses the clip. When an English clip is missing,
an available Vietnamese clip is used and labelled as Vietnamese. Written panel
text stays in the selected language, and only that language's transcript is shown
if supplied. If neither clip exists, the written explanation remains available.
A playback failure keeps the explanation visible and offers a retry.

Manual acceptance: sign in as a student and a teacher, start/skip/resume the tour,
finish it, restart from Settings, and switch languages. Add a synthetic short clip
with captions/transcript and check playback, optional transcript hiding, media
failure/retry, keyboard/Escape/focus, navbar scrolling and window resizing. Verify
that another dialog or active task defers the tour and account switching stops
playback without exposing another account's progress. Automated checks use local
fixtures and do not require your recordings.

### Remotion onboarding previews

Five Vietnamese videos are authored separately from the desktop in
[examples/previews/onboarding](examples/previews/onboarding/RegisterOnboardingVideos.tsx).
They cover Lớp học, Tiến độ học tập, Bài giảng hướng dẫn, Micrô and Thú cưng.
The approved exports are bundled under `src/desktop/assets/onboarding/vi/`.
The tour keeps Workspace as a text introduction, then covers the five video topics.
Micrô highlights the navbar microphone button; Thú cưng highlights Settings and
explains where to find its Pets tab. Adding steps preserves completed/dismissed
tours; use Restart onboarding to replay. The three classroom clips demonstrate
student actions and are not substituted for teacher-specific instructions.

```sh
pnpm preview:onboarding
```

Open the printed Studio address (normally `http://localhost:4310`) and select
`TroClassesVi`, `TroInsightsVi`, `TroGuidedLessonsVi`, `TroMicrophoneVi` or
`TroPetsVi`. Press Play to hear Vietnamese AI narration from OpenAI Marin.
Each is exactly 10 seconds, 1280×720 at 30 fps. Shot direction lives in
[VideoContent.ts](examples/previews/onboarding/VideoContent.ts); concise spoken
scripts and the speech profile live in
[VideoNarration.ts](examples/previews/onboarding/VideoNarration.ts).
The five exports are H.264/AAC MP4s with half-size PNG posters and Vietnamese
plain-text transcripts. Each video is exactly ten seconds. The selected locale
uses the existing Vietnamese fallback until English recordings are supplied.
Export requires FFmpeg (including `ffprobe`). It is manual and reuses the existing
speech tracks without provider calls:

```sh
# Run only after approving the source previews.
pnpm export:onboarding
# Optionally use an already installed Chrome executable:
pnpm export:onboarding --browser-executable "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
pnpm build:desktop
```

[VideoExports.ts](examples/previews/onboarding/VideoExports.ts) owns the approved
composition-to-filename mapping. The command renders all five into a temporary
folder, checks duration/codecs and decodes every frame before copying MP4s,
posters and transcripts into the app. It runs no paid generation and is never
part of normal startup/build. Source screens and Remotion tooling stay outside
the desktop bundle; only exported media is packaged. Review a new export before
releasing a desktop update. The `onboarding.export.encoded` event reports each
composition’s raw encoded duration, frame count and frame rate before the final
ten-second audio edit. It contains no account, credential or capture data.

Audio uses OpenAI's `gpt-4o-mini-tts` speech endpoint with the built-in `marin`
voice, not a clone of the user's voice. See the
[official speech guide](https://developers.openai.com/api/docs/guides/text-to-speech).
To regenerate after changing a spoken script, install FFmpeg (including `ffprobe`)
and explicitly authorize the provider calls, then run with the intended backend
Doppler config:

```sh
doppler run --project tro-api --config dev_personal -- pnpm prepare:onboarding-audio --generate
pnpm check:onboarding-videos
```

Generation may incur provider charges. It sends only the five short scripts to
OpenAI; Doppler injects the key only into the command process. The key never
enters source files, Studio, browser assets or logs. A matching input/audio hash
receipt reuses an existing track rather than making another paid request. The
command makes no automatic provider retries. Without `--generate`, it refuses
to dispatch. Safe failure events contain only provider status and request ID.

The command creates MP3 narration and non-secret hash/duration receipts, never
video exports. Audio is mono, 24 kHz, 64 kbps, normalized for clear speech. If a
track slightly exceeds the target, at most 15% tempo adjustment may fit it; longer
speech is preserved for review rather than truncated or silently regenerated.
Source audio remains under ignored `.tro-development/onboarding-narration/`.
Existing audio lets Studio work without credentials or paid calls. The local
checker verifies narration hashes, measures duration to prevent speech being cut
off at 10 seconds, and checks screenshot dimensions and crop/cursor bounds.
Review pronunciation, pacing and visual fit in Studio before approving export.

Screens under `public/Screens/` were captured at 1280×800 on October 11, 2026 from
Tro's actual React renderer using
[CaptureDesktop.ts](examples/previews/onboarding/CaptureDesktop.ts) with fictional
classes, learning records, and accounts. They are frozen demonstration assets,
not real student data or evidence of learning outcomes. To refresh them:

```sh
pnpm preview:onboarding-capture
```

Open `http://127.0.0.1:4311/examples/previews/onboarding/CaptureScreens.html`.
Add `?onboarding` to review the installed clips in the real tour using ephemeral
preview progress, without touching any real account.
This capture page connects no backend, real account, model or native capabilities;
its microphone inventory is synthetic and no microphone test should be recorded
as a real hardware result. Capture the intended states at 1280×800 and review the
matching crops after replacing an image. Brand assets are copied from Tro's owned
asset directory; the pet provider notice remains beside the copied sprite.

Studio currently warns that the application's Zod version differs from its
recommended Zod version. These compositions use no Zod props editor; do not
downgrade the application's shared validation dependency just to silence the warning.

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
[ClassroomInsightConfig.ts](src/server/config/ClassroomInsightConfig.ts).

Select **Pet world** in the navbar to recognize students and personalize a pet's
home. Teachers select an owned class and enrolled students, enter a positive whole
point amount and grant it manually. There is no teacher issuance budget. Students
spend their own points in the shop, place owned decorations and equip passive pet
backgrounds. The existing pet gallery controls whether the floating companion is
shown on this device. Homes stay private until their owner shares with a class.
Class garden milestones count recognized moments; learning evidence remains in
Insights and practice review. Interrupted actions appear as pending requests;
retry the original action to reconcile its result. Awards and purchases require
the API, while confirmed cosmetic appearance can remain available offline.
Normal startup applies the additive Pet World migration; it does not import demo
balances or award points automatically. This feature makes no model calls.

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
pnpm audit
```

Unit tests require no credentials or live database. Integration tests need Docker
and create/migrate/remove a disposable PostgreSQL container. Run
`pnpm test:worker` for worker bundling/startup changes. These checks use local
fixtures and do not call a paid provider.

Security overrides in [pnpm-workspace.yaml](pnpm-workspace.yaml) constrain affected
transitive dependencies until their parent packages adopt fixed releases. The
Electron downloader's proxy adapter uses a release without the unpatched
`sprintf-js` dependency. Keep these overrides and the lockfile together when
updating dependencies; run the audit without filtering development or optional
packages. [HttpCacheSemantics.patch](patches/HttpCacheSemantics.patch) additionally
prevents client `max-stale` from bypassing response reuse restrictions: the
regression still reproduces in the release marked fixed by the registry for
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
The dependency regression tests exercise the resolved downloader chain; retain the
patch until those cases pass against an upstream release without it. Docker installs
copy the patch before the frozen lockfile install.

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

### Signed macOS release from GitHub Actions

[MacRelease.yml](.github/workflows/MacRelease.yml) is manually dispatched from
reviewed `main`. It runs the full Linux validation suite, then builds the pinned
native companion and desktop separately on Apple Silicon and Intel runners. It
requires Developer ID signing, Apple notarization and stapling, and verifies both
the ZIP's extracted app and the DMG's mounted app before uploading artifacts.
It does not publish a GitHub Release or change website download links.

The workflow is prepared for activation after Apple Developer enrollment. Its
presence does not mean a signed Mac release has passed hardware acceptance.

#### Apple setup after enrollment

1. Confirm active membership and the intended Apple Team ID. Create a
   **Developer ID Application** certificate with its private key, and export a
   password-protected P12. A `.cer` alone cannot sign. DMG/ZIP distribution does
   not need a Developer ID Installer certificate or an App Store provisioning
   profile for the current capabilities.
2. Create an App Store Connect **team API key** with App Manager access for
   notarization. Keep its P8, key ID and issuer ID. Do not use an issuer-less
   individual key with this pinned electron-builder version.
3. Create GitHub environment `release-macos`, restrict it to `main`, and configure
   the following secrets/variables. Do not paste private keys into chat or commit
   them. Base64 encodes transport bytes; it does not encrypt them.

| Setting                        | GitHub environment storage                                    |
| ------------------------------ | ------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12_BASE64` | Secret: exported Developer ID Application P12, base64 encoded |
| `MACOS_CERTIFICATE_PASSWORD`   | Secret: P12 password                                          |
| `APPLE_NOTARY_KEY_P8_BASE64`   | Secret: notarization team API private key, base64 encoded     |
| `MACOS_SIGNING_IDENTITY_SHA1`  | Variable: exact 40-hex certificate fingerprint                |
| `APPLE_TEAM_ID`                | Variable: expected 10-character Apple Team ID                 |
| `APPLE_API_KEY_ID`             | Variable: team API key ID                                     |
| `APPLE_API_ISSUER`             | Variable: team API issuer UUID                                |
| `MAIN_VITE_API_BASE_URL`       | Variable: production public HTTPS API URL                     |

The certificate fingerprint selects an identity; release artifact integrity uses
SHA-256. Find the usable identity with `security find-identity -v -p codesigning`.
The workflow imports its key into an isolated temporary keychain, restores the
runner's prior search list, and removes credentials in an always-run cleanup.
Certificate/key values are absent from the application configuration and uploaded
artifact allowlist. Native dependency compilation happens before credentials are
installed. Standard build/test/local packaging needs no Apple account.

#### Run and inspect a candidate

```sh
gh workflow run MacRelease.yml --repo ducnguyen67201/TroApp --ref main
```

Select the resulting run in GitHub Actions and confirm **both** architecture jobs
passed. Artifacts are named `Tro-macos-<arch>-<sha>-<run-id>-<attempt>` and contain
`Tro-<version>-macos-<arch>.dmg`, the matching ZIP, and
`MacSignatures-<arch>.json`. Download artifacts from that exact run; they expire
after 14 days and are not permanent public release URLs. The inventory records
final hashes, app archive hash, native minimum OS versions, expected team, and
Apple DMG submission ID. Its `preSigningCompanion` section records the input
provenance verified before Developer ID signing changes the native executable.

The first Mac release deliberately disables installed update feeds. Release mode
rejects a nonempty `MAIN_VITE_UPDATE_FEED_URL` or staged update publishing config,
because stapling the DMG changes its bytes after builder metadata generation.
Future update support must generate hashes after final stapling and validate both
architecture feeds; do not enable updates by setting a variable alone.

On a Mac with the same validated release settings, the owning verification entry
points are:

```sh
pnpm exec tsx scripts/MacSigning.ts --check-macos-release
pnpm package:desktop
pnpm exec tsx scripts/VerifyMacRelease.ts --directory release --arch arm64
pnpm check:microphone-package release/mac-arm64/Tro.app
```

Use `--arch x64` and `release/mac/Tro.app` on Intel. Verification checks native
architecture, Developer ID/Team ID, secure timestamps, hardened runtime, expected
bundle ID, entitlements, companion provenance, app version, Gatekeeper acceptance,
and staples. It rejects native minimum OS versions above the currently advertised
macOS 13.0; raising that minimum requires a reviewed website/docs change.
`codesign --verify --deep --strict`, `xcrun stapler validate`, and
`spctl --assess --type execute --verbose=4` are useful independent checks against
the downloaded app. Signing uses inside-out native resource handling; `--deep` is
used for verification, not blanket signing. No library-validation bypass is added.

#### Diagnostics and recovery

`mac.release.stage` identifies archive verification or container notarization.
`mac.release.notary.submitted` records a submission ID before polling;
`mac.release.notary.rejected` reports that ID and issue count without raw Apple
messages. `mac.release.command.failed` names the failed tool without arguments.
`mac.release.verified` is emitted only after the inventory is written. No inventory
is uploaded if any preceding step fails.

For missing identities, check P12 private-key export, fingerprint, Team ID and
certificate validity. For notary authorization failures, check team API access and
key/issuer pairing. Inspect Apple's detailed log privately using the recorded ID;
do not paste credentials or raw logs into public issues. The DMG verifier submits
once and polls that ID for up to 30 minutes. After a timeout or network failure,
check that ID before creating another candidate. App notarization runs through
builder's pinned integration and is also bounded by the job timeout. Rejection,
missing staples or failed Gatekeeper assessment must never downgrade to unsigned
output. Fix the owning stage and rerun a reviewed candidate.

#### Hardware acceptance and rollout

Test browser-downloaded, quarantined DMG and ZIP on real Apple Silicon and Intel
Macs using normal Gatekeeper settings. Install to Applications, launch via Finder,
and check OAuth callbacks, saved accounts, permission onboarding, Screen Recording,
Accessibility, microphone routing, global shortcuts, native teaching/HUD,
click/drag/Esc, shutdown and relaunch. Verify the advertised minimum OS and an
upgrade from the legacy app without deleting user data. New signing identity may
require permission reauthorization. Hosted CI cannot prove these interactions.
Do not remove quarantine or disable Gatekeeper to count a test as passing.

After approval, choose a new unused release version committed before the build;
never overwrite the Windows `v0.1.0` tag with different source. Publish **the exact
verified files** from both architecture artifacts to a draft TroApp GitHub Release
at the build SHA, compare hashes, record hardware acceptance, then publish. Keep
existing Windows assets intact. The marketing website is a separate repository
(`ducnguyen67201/Tro`): its Mac source migration must wait for these verified
releases. Its resolver must select releases per platform so a Mac-only release
cannot hide the older Windows installer. Deploy that separately reviewed website
change only after both Mac downloads are public, then verify all three redirects.

Developer ID signing and notarization do not pregrant macOS privacy permissions
or remove the normal Internet-download confirmation. The expected outcome is
successful Gatekeeper assessment, not the absence of every operating-system prompt.

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
