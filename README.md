# Tro

Electron + React desktop, strict TypeScript API and Prisma/PostgreSQL persistence.
Tro supports authenticated computer use, student-controlled teaching, classroom
materials, voice input and native macOS/Windows companion support.

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
If Electron reports `ERR_FAILED` while opening the development renderer, inspect
`desktop.child_process.failed` for the process type, reason, exit code and Network
Service classification. `desktop.renderer.load.failed` reports the navigation
code, attempt, elapsed milliseconds and whether recovery will run; no URL or
profile contents are logged. An observed Network Service failure during the first
development load permits a bounded retry of the same document after a short delay.
`desktop.renderer.load.recovered` confirms success. Persistent failures, ordinary
connection failures and shutdown still propagate. Killing another server does not
repair an Electron helper crash; check which event failed before changing ports.
For process-list parsing failures, `processMetadata` identifies the failing
snapshot (`processes` or `executables`), record number, character count, numeric
PID when available, and whether a start-time shape was present. These fields help
diagnose host-output differences without exposing the raw process record.
Process discovery uses the `C` locale for consistent date parsing; your terminal
and development services keep their configured locales.

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

## Company computers and student QR login

Apply committed migrations through the normal local setup (`pnpm dev`), then restart
the desktop/API with the new build. Existing accounts and work are preserved.

1. On the organization owner's personal computer, open **Settings → Team → Company
   computers** (**Cài đặt → Đội nhóm → Máy tính của tổ chức**). A platform admin can
   also manage the selected organization. Choose **Create organization activation
   code** (**Tạo mã kích hoạt tổ chức**); no computer name is required.
2. On the company computer, sign out all saved personal accounts. On the welcome
   screen choose **Company computer · Student QR**, then enter the complete `TRO-`
   activation code and choose **Activate computer**. Share the same organization code
   with everyone setting up company computers: it can activate multiple installations
   until it expires or is revoked. Each computer gets an automatic name such as
   **Computer 1** and its own authorization record. Class invitation codes cannot
   activate computers. Already activated computers retain their independent
   authorization until their own expiry or revocation.
3. Students scan a QR containing their unique text, random value or URL, or enter
   that exact text manually. A name is needed only on first sign-in. Later sign-ins reopen the same organization
   student account and saved work on any authorized company computer. No email,
   Google account or running class is required for QR login.
4. An assigned teacher opens **Class settings → Add a QR student**, enters the
   student's exact QR text (or school ID) after their first login, and chooses
   **Enroll QR student**.
   Computer activation and organization membership do not enroll students in all
   classes. Students see only classes they have been explicitly enrolled in.
5. Students choose **Change student** when finished. The computer forgets their
   login and retains company authorization. Student accounts and work stay on the
   backend. Idle expiry/app exit also end temporary access; restart requires scanning
   again. Personal computers continue using Google and remembered personal accounts.

On a personal computer, **Add account → Sign in with QR** (**Thêm tài khoản →
Đăng nhập bằng QR**) is an alternative to Google. Enter the same organization
activation code once to enable QR login on that installation, then scan a student's
card. Google accounts stay saved, QR accounts are remembered in the encrypted
account switcher, and either can be selected later. This personal flow does not
convert the installation into a company computer. Company setup from the welcome
screen continues to use temporary QR-only sessions.

The owner can refresh **Company computers** to see authorized installations (both
personal and company), unique QR student accounts, students signed in today (UTC),
and sign-in counts. Twenty new sign-ins by one student count as one student and twenty sign-ins; retrying a failed
submission does not create another login event. These counts describe QR accounts
and installation grants, not continuous presence, verified real people or paid seats.
The same panel shows activation counts per active code. **Stop new activations**
revokes a code without signing students out of already authorized computers;
**Revoke computer** disables an individual installation. Removing a student from
the team blocks their QR account; removing class enrollment blocks that class only.

To return a signed-out company computer to personal mode, open the company-computer
login and choose **Remove company authorization**. This requires the backend to
acknowledge revocation before local storage is removed; retry if offline.

QR text is an opaque account key: URLs, random values and multiline text are
accepted without opening links, executing code or interpreting embedded roles.
Case, leading zeros, whitespace and line breaks are preserved. Each student needs
a distinct QR; anyone using the same QR on an authorized computer opens the same
organization learner account. This is not verified provider login or Google-account
recovery. Empty/whitespace-only text, null characters and text above the bound owned
by [StudentIdentity](src/contracts/StudentIdentity.ts) are rejected. The development
warning `student.qr.rejected` reports only validation stage, reason and character
count; it never logs QR contents or camera images. Current QR flows support typed
lessons. Existing legacy
personal-class grants and saved learner accounts remain readable, with their original
class/live-session restrictions. Old class setup codes and roster-import commands
are retired; new computer activation requires an organization-issued `TRO-` code.
See [Architecture](docs/Architecture.md#email-free-student-access) for boundaries,
compatibility and technical policy ownership. Never post activation codes, QR IDs or
credentials in issues or ordinary logs.

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

### PostHog usage tracking

The desktop supports optional [PostHog product analytics](https://posthog.com/docs/libraries/node).
In an ignored `.env.local`, set `MAIN_VITE_POSTHOG_PROJECT_TOKEN` to the public
project token and `MAIN_VITE_POSTHOG_HOST` to `https://us.i.posthog.com` or
`https://eu.i.posthog.com`. Supply both or neither; personal API keys are rejected.
Restart development or rebuild the desktop after changing these build settings.
For installed releases, set the same two public variables in the GitHub `release`
environment before running Desktop Release. No backend secret
or PostHog management credential belongs in the desktop.

Sharing is on by default when PostHog is configured, with no first-launch prompt,
and applies to all accounts using this installation. Existing saved opt-outs remain
off. Use **Settings → General → Share app usage** to turn it off. Disabling stops subsequent
collection and aborts queued/in-flight delivery; it cannot remove already received
PostHog events. Re-enabling generates a new random installation identifier.
Preference save failures are visible and can be retried; a failed opt-out save
still disables sharing until restart.

Events cover app openings, fixed screen names, agent task starts/results/durations,
explicit classroom join/leave/start/end/check/submit outcomes, onboarding transitions
and renderer process failures. Ordinary refreshes are excluded. Practice-check
success means the API accepted the operation, not that a student passed assessment.
The [event contract](src/contracts/Analytics.ts) owns the allowed properties.
No names, emails, account/class identifiers, instructions, student work, URLs,
screenshots, audio, raw errors or session recordings are sent. GeoIP enrichment,
person profiles, automatic exception capture and feature flags are disabled.

In PostHog, use `app_opened` unique identifiers for active installations,
`screen_viewed` broken down by `screen` for feature discovery, and
`agent_task_finished` broken down by `result`, `outcome` or `teachingOutcome`
for task outcomes. Filter `appEnvironment` to separate development from production.
Counts cover installations with sharing enabled, not individual students or learning attainment.
Delivery is bounded and best effort; offline events are not saved to disk.

For a manual smoke check, use a test project, launch a fresh installation, navigate between
screens, and inspect PostHog Activity for only the allowed properties. Turn sharing
off and repeat; no new events should arrive after already-sent requests settle.
Relaunch and verify the saved opt-out remains off, then re-enable it in Settings
if desired. A fresh configured installation saves its random identity before sending.
Automated tests use fakes and do not send events to a real project.

### Native setup

```sh
pnpm build:cua
pnpm dev
```

`build:cua` requires Rust; Windows also requires the MSVC C++ build tools, their
Spectre-mitigated libraries for the target architecture, and the Windows SDK.
It fetches the pinned Cua source, applies `CursorCompanion.patch`, runs
companion, MCP transport and session tests, builds the local executable (ad-hoc signed on macOS) and
records checksums in `~/.cache/tro/cua-companion`. Run `pnpm build:cua` once on Windows
before `pnpm dev`; installers bundle the same patched companion. Restart the desktop after
rebuilding so its daemon loads that executable.
If the API is already running, use `pnpm dev:desktop` to restart only the desktop.
After native-driver edits, regenerate the patch and run `pnpm build:cua` again
before restarting. Ordinary TypeScript/React edits do not require that rebuild
unless they change native contracts. Follow the
[native maintenance workflow](docs/Architecture.md#maintaining-native-driver-changes)
when updating the patch or pinned upstream source. Then run the repository
[validation commands](#validation) and perform the affected platform's hardware checks.
`companion.presentation.failed` reports a bounded startup/connect stage and reason;
the native `companion` warning with `stage=input_hooks` identifies unavailable
Windows input observation. Neither event includes screen content or key values.
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

The macOS launcher uses the checkout-owned `.tro-development/tro-dev.app`, shown as
**tro-dev**. Quit it before rebuilding its static host. Development uses the
`tro-dev` app name, OS app-data directory and Keychain namespace; the released app
keeps `tro`. Existing `tro` data is not automatically copied or deleted. The first
launch with the separate development profile requires signing in again. The
development bundle has a separate identity
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

## Organizations and team

Apply the committed migration through normal startup. Sign in with Google before
an administrator appoints an owner, so the owner has a verified account. Platform
administration uses the existing backend-owned `User.isAdmin` flag; organization
owners never receive that flag automatically.

After login, accounts without a team choose how to use Tro. **Continue on my own**
saves a personal-use choice across devices; no organization is created. Only a
platform admin or an admin-approved owner can choose **Create organization**.
Admins approve a verified account in **Settings → Team → Owner approvals**. This
approval lets that person name and create their organization after login; it does
not make them a platform admin. Approved owners can choose personal use and create
later from Team. Existing provisioned owners can defer unfinished setup.

Owners review the name before confirming it. The name stays permanent, including
after ownership transfer. Existing names remain preserved and locked. Owners use
**Add member**, enter an email and select Teacher or Student permissions. Existing
verified users join immediately. New email addresses are added to the team and join
automatically on their first verified sign-in. No code, invitation acceptance or
invitation email is needed. Owners can change permissions and remove members,
including emails whose users have not signed in yet. Current unexpired legacy
invitations are migrated to direct additions; expired/revoked invitations are not
restored. Rejoining never restores previous classroom enrollments automatically.

**Organization logo** is collapsed below the member list. Owners can upload, replace
or remove it, or click the sidebar logo to open its controls directly. PNG, JPEG and
WebP files up to 2 MB and 4096 × 4096 pixels are supported. The sidebar keeps a Tro
badge, and the assistant stays Tro. Multi-organization accounts can select branding
for the current session from the sidebar logo menu. Admin ownership transfer is in
Owner approvals, separate from teacher/student permissions. Ownership grants no
classroom access. Ordinary members see their own organization and permissions,
without the member directory. Organization limits are owned by the
[contract](src/contracts/Organizations.ts).

Teacher/student roles belong to each organization. When creating a class, choose
the organization where you teach. Existing classes and courses keep their original
access rules and are not assigned to an organization by the migration. Moving
historical classes is explicit: open **Settings → Team → Class assignments**, select
**Link existing class**, choose your own personal class and confirm. End live
sessions and add all enrolled students to the team first. The class must have its
own unscoped course revision. Shared-course cases require a separate reviewed mapping.

In **Class assignments**, owners select all assigned teachers for each organization
class and select **Save teachers**. Only active Teacher members are eligible. Each
class supports multiple teachers. Adding a teacher keeps the others; unchecking a
teacher removes their class access. Keep at least one assigned teacher.
End any live session before changing the assignment. Teachers see only their assigned
classes, and students see only enrolled classes. Organization QR students first sign in
on an organization-authorized computer, then an assigned teacher enrolls their exact
QR text or school ID in Class settings. Google students retain the email enrollment
path. Organization ownership alone exposes class names and assignment controls, without classroom content or progress. Removal
revokes organization resource access on subsequent backend requests while preserving
historical work and personal pet entitlements.

For a local smoke check, use an admin, owner, teacher and student account: create an
organization after approving its owner, confirm its permanent name, add members
directly, change permissions and remove a member. Link a personal class and assign two
teachers; verify that both can manage it, then remove one and verify their access ends.
Test both an existing verified
account and a new email that joins on first sign-in. Reopen Tro and confirm naming is not requested
again; verify that ownership transfer does not allow a name change.
Confirm a non-admin cannot appoint an owner, a non-owner cannot manage members, and
an owner cannot open another teacher's class without classroom access. Confirm an
outsider cannot accept a classroom invitation into an organization they have not
joined, and a removed member loses access even through a saved class route.

## Classroom pilot

Apply committed migrations through normal startup. Legacy accounts default to
Student; a backend operator can grant/revoke their global role by verified email.
This command applies to unscoped legacy classes; organization roles are managed
in Settings → Team:

```sh
doppler run -- pnpm account:role teacher@example.com teacher
```

Use `student` to revoke teacher access. Sign in as the teacher, create a class,
upload materials, prepare/review and approve an immutable publication. Enroll a
student who has signed in or provide an invitation code. Start a session and select
its section, stage and pacing. Sign in as an enrolled student and explicitly join.
Account switching permits sequential teacher/student checks on one device; it does
not establish simultaneous two-device behavior.

Accounts also have a separate `User.isAdmin` boolean, defaulting to false. After
applying the committed migration, an operator can set it in the backend database
for the intended account (the Prisma `User` model maps to the `user` table).
Refresh Classroom to pick up a change, then use **View as: Me** to search teachers
and students by name or email. Selecting a person opens their existing classroom
screens with full classroom permissions: actions save real changes for that person.
Use **Return to my account** to leave the selected view. Finish active work before
switching. The admin remains signed in; other product areas keep the admin identity.
Selecting a student does not join a session until you choose **Join session**.
Setting the field back to false revokes delegated access on the next request.
Backend `classroom.view_as.completed` events record the admin ID, selected person
ID, operation, request ID and result without logging submitted classroom content. No
account is granted admin access by the migration. Apply it with `pnpm db:deploy`
against the intended backend before deploying the updated API. Existing desktop
releases retain their original classroom response; admin viewing requires the
updated desktop.

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
shown on this device. Every enrolled student's pet home appears automatically in
all their class neighborhoods once their pet profile is set up. Removing a student
from a class removes their home there; re-enrollment restores visibility. Classmates
can view each pet's owner name, pet and decorations, while points and teacher notes
stay private.
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

### Shared desktop release version

Run **Actions → Desktop Release → Run workflow** on reviewed `main`.
[DesktopRelease.yml](.github/workflows/DesktopRelease.yml) reserves one shared
patch version in an annotated `desktop-v<version>` tag, then builds Windows x64
and macOS Apple Silicon/Intel from the reviewed source commit. For example, the
first release from the `0.1.0` baseline builds all three targets as `0.1.1`.
The next run uses the highest reserved version or committed baseline, whichever
is newer, before incrementing the patch. Artifact names and installer filenames
include the version; the run summary identifies its tag and source commit.
[ApplyDesktopReleaseVersion.ts](scripts/ApplyDesktopReleaseVersion.ts) applies the
reserved version to `package.json` in each disposable build checkout. The workflow
preserves the protected `main` branch and its development baseline; local
build/package commands do not reserve or increment release versions.

Desktop Release runs lint, formatting, type checking, unit tests, build and database
integration checks once in a shared Linux job against the reserved source/version.
Windows and both Mac packages start after that job succeeds. Native builds restore
Cargo downloads and compilation outputs from separate caches per runner,
architecture and Rust toolchain, with keys tracking the pinned companion contract,
patch and build script. Cache misses rebuild normally; every run still checks the
pinned source, applies the patch, runs native tests and builds before signing.
Signed packages, staged companions and signing credentials are not cached.
The first release fills these caches; later releases can reuse unchanged native
dependencies. Apple notarization remains dependent on Apple's service latency.

Re-run failed jobs in the existing Desktop Release run to retry the same version.
A new manually dispatched run allocates the next patch version, even if the prior
release failed; version gaps are allowed. Runs are serialized. If `main` advances
before preparation reserves a version, start a new run. Preparation and final
publication have `contents: write`, for their tags and GitHub Releases; platform
builds keep read-only repository access. Preparation never pushes to `main`,
force-updates a tag or deletes a reservation. Keep `desktop-v*` tags immutable;
do not delete them to retry a release. Signing remains in the existing
`release` environment, with shared validation before platform packaging.
`release.version.stage` and `release.version.failed` report a bounded preparation
stage/reason without Git output or credentials. `source_changed` requires a new
run; `git_operation` at `publish` requires checking tag-creation permissions or push access.

The Windows release also silently installs/uninstalls the signed installer on its
disposable runner and checks the installed version, patched driver and both shortcut
targets. `release.installer.failed` identifies installation, version, native-driver,
shortcut or uninstall failure. This check refuses an existing Tro installation and cannot
run in normal local development. Uninstall waits for the temporary install directory
and both shortcuts to disappear, since NSIS removes them in separate stages.
`release.installer.cleanup` reports completion, elapsed milliseconds and booleans
identifying remaining application files, Start menu or desktop shortcuts. A cleanup
timeout still fails the release. Its credentialless shortcut and cleanup fixtures can be run
on Windows with:

```powershell
./scripts/CheckWindowsInstaller.ps1 -Mode Test
```

### Signed macOS release from GitHub Actions

[MacRelease.yml](.github/workflows/MacRelease.yml) is called by Desktop Release
with its prepared version and commit after shared Linux validation. It builds the pinned
native companion and desktop separately on Apple Silicon and Intel runners. It
requires Developer ID signing, Apple notarization and stapling, and verifies both
the ZIP's extracted app and the DMG's mounted app before uploading artifacts.
Once both Mac architectures and Windows succeed, Desktop Release publishes all
verified installers together. trohoc.site discovers the published downloads
automatically; see [Automatic release publication](#automatic-release-publication).

The workflow is prepared for activation after Apple Developer enrollment. Its
presence does not mean a signed Mac release has passed hardware acceptance.

#### Apple setup after enrollment

1. Confirm active membership and the intended Apple Team ID. Create a
   **Developer ID Application** certificate with its private key, and export a
   password-protected P12. A `.cer` alone cannot sign. DMG/ZIP distribution does
   not need a Developer ID Installer certificate or an App Store provisioning
   profile for the current capabilities.
2. Create an **app-specific password** in the Apple Account's Sign-In and Security
   settings for Tro CI notarization. Save it and the P12 export password in your
   password manager. Use the Apple account email authorized for the same team.
3. Configure GitHub environment `release`, restrict it to `main`, and configure
   the following secrets/variables. Do not paste private keys into chat or commit
   them. Base64 encodes transport bytes; it does not encrypt them.

| Setting                       | GitHub environment storage                                    |
| ----------------------------- | ------------------------------------------------------------- |
| `CSC_LINK`                    | Secret: exported Developer ID Application P12, base64 encoded |
| `CSC_KEY_PASSWORD`            | Secret: P12 export password                                   |
| `APPLE_ID`                    | Secret: Apple account email                                   |
| `APPLE_APP_SPECIFIC_PASSWORD` | Secret: app-specific password for Tro CI notarization         |
| `MACOS_SIGNING_IDENTITY_SHA1` | Variable: exact 40-hex certificate fingerprint                |
| `APPLE_TEAM_ID`               | Variable: expected 10-character Apple Team ID                 |
| `MAIN_VITE_API_BASE_URL`      | Variable: production public HTTPS API URL                     |
| `MAIN_VITE_UPDATE_FEED_URL`   | Variable: shared public HTTPS update feed; required           |

Enter both passwords directly into the corresponding GitHub environment secret
fields. Do not send passwords in chat, put them in source, or place them in
`MAIN_VITE_*` values. To prepare the certificate for `CSC_LINK` on macOS, pipe
`base64 -i /absolute/path/TroDeveloperId.p12 | tr -d '\n' | pbcopy`, paste into its
secret field, then clear the clipboard. Keep the export outside the checkout.

The certificate fingerprint selects an identity; release artifact integrity uses
SHA-256. Find the usable identity with `security find-identity -v -p codesigning`.
The workflow downloads the Developer ID G2 intermediate from [Apple PKI](https://www.apple.com/certificateauthority/),
checks its pinned SHA-256, and imports it without changing certificate trust.
It imports the signing key into an isolated temporary keychain and stores the
notarization password there as the `tro-ci-notary` profile. Only this credential
installation step receives GitHub secrets. Packaging and DMG notarization use
`APPLE_KEYCHAIN` and `APPLE_KEYCHAIN_PROFILE` to read the stored profile. Cleanup
restores the runner's prior search list and removes credentials even on failure.
Certificate/key values are absent from the application configuration and uploaded
artifact allowlist. Native dependency compilation happens before credentials are
installed. Standard build/test/local packaging needs no Apple account.

#### Run and inspect a candidate

```sh
gh workflow run DesktopRelease.yml --repo ducnguyen67201/TroApp --ref main
```

Select the resulting Desktop Release run in GitHub Actions and confirm **both**
macOS architecture jobs passed. Artifacts are named
`Tro-<version>-macos-<arch>-<sha>-<run-id>-<attempt>` and contain
`Tro-<version>-macos-<arch>.dmg`, the matching ZIP, and
`MacSignatures-<arch>.json`. Download artifacts from that exact run; they expire
after 14 days and are not permanent public release URLs. The inventory records
final hashes, app archive hash, native minimum OS versions, expected team, and
Apple DMG submission ID. Its `preSigningCompanion` section records the input
provenance verified before Developer ID signing changes the native executable.

Signed Mac builds embed the stable GitHub feed configured in
[MacRelease.yml](.github/workflows/MacRelease.yml). Builder's `latest-mac.yml`
contains hashes from before final DMG stapling and is never published directly.
The final publisher regenerates one manifest covering both architectures from
the final verified ZIP/DMG bytes. Unknown metadata and stale archives still fail
distribution verification.

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
Signed Mac builds compile native dependencies from source. Before signing, the
workflow runs `pnpm exec tsx scripts/PrepareElectronHeaders.ts` to install the
pinned Electron version's headers in the rebuild tool's `~/.electron-gyp` cache.
The cache is separated by OS, architecture and lockfile. Fresh downloads retain
node-gyp's checksum checks; incomplete installations are rolled back. Preparation
retries allowlisted connection/DNS timeouts and resets up to three attempts before
signing credentials are loaded. `desktop.headers.prepare` events report the version,
architecture, attempt and safe failure code; compiler and integrity errors are not
retried. If an existing run fails on a transient header download, use **Re-run failed
jobs** to retain its successful platform artifacts and reserved version.
Before signing, the
hook's rebuilt `build/Release/uiohook_napi.node` must match the release architecture
and support macOS 13.0. The shipped hook prebuilds require 13.5 and are removed;
the native loader selects the rebuilt binary. Load-command inspection uses
`otool -m -l` so parenthesized Electron helper names remain literal file paths.
`codesign --verify --deep --strict`, `xcrun stapler validate`, and
`spctl --assess --type execute --verbose=4` are useful independent checks against
the downloaded app. Signing uses inside-out native resource handling; `--deep` is
used for verification, not blanket signing. No library-validation bypass is added.

#### Diagnostics and recovery

`mac.release.stage` identifies settings/version reads, artifact selection and reads,
temporary extraction setup, archive verification or container notarization.
If artifact selection fails,
`mac.release.artifacts.rejected` reports expected-file presence, file counts and
known builder-sidecar presence without logging arbitrary filenames or paths.
The selector ignores the builder's exact `builder-debug.yml` and
`builder-effective-config.yaml` diagnostic filenames; they are never uploaded.
Other YAML files, including update metadata, still reject the candidate.
`mac.release.failed` includes an allowlisted filesystem/argument error code and
whether schema validation failed, while keeping the original error private.
`mac.release.notary.submitted` records a submission ID before polling;
`mac.release.notary.rejected` reports that ID and issue count without raw Apple
messages. `mac.release.command.failed` identifies the allowlisted tool/operation,
numeric exit code, termination signal, elapsed milliseconds and a fixed failure
category. For network failures, `urlErrorCode` preserves only the numeric
`NSURLErrorDomain` code when present (for example, timeout `-1001` or secure
connection failure `-1200`); otherwise it is null. It never includes raw command
arguments, paths, tool output or errors.
For `stapler.staple` and `stapler.validate`, distinguish `ticket-not-found`, `ticket-not-stapled`,
`ticket-validation-failed` and `network-error`; `unknown` requires further
diagnosis, not a guessed retry or a relaxed verification gate. Ticket stapling and validation
retry only exit 68 with a network-error marker, at most five attempts with
5-, 15-, 30- and 60-second delays. Missing-ticket messages, invalid/revoked ticket
exit codes and terminated commands are not retried. `mac.release.command.retry` records the
attempt, next attempt, limit and delay without raw tool output. A persistent
network or TLS error still fails the release; other commands are not retried by
this policy. A prior
`notarization successful` message does not replace the separate ticket check.
The DMG notarization step requires a successful ticket validation before returning;
the release verifier then checks Gatekeeper and the mounted contents without
repeating that same online ticket check on the unchanged DMG.
`mac.release.verified` is emitted only after the inventory is written. No inventory
is uploaded if any preceding step fails.

For missing identities, check P12 private-key export, fingerprint, Team ID and
certificate validity. For notary authorization failures, check the Apple account's
team membership, app-specific password and stored keychain profile. The tooling
also supports team API keys for separately configured local release environments;
do not mix API-key and keychain-profile credentials in one invocation. Inspect
Apple's detailed log privately using the recorded ID; do not paste credentials or
raw logs into public issues. The DMG verifier submits
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

Complete hardware acceptance on a reviewed candidate before dispatching the public
Desktop Release workflow, and record the result with the release review. Dispatch
now authorizes automatic publication after all platform checks pass; it does not
pause for a separate manual publication step. Existing release tags and assets
are preserved. After publication, verify all three trohoc.site download redirects.
The marketing website is maintained separately in `ducnguyen67201/Tro` and already
selects published installers per platform.

Developer ID signing and notarization do not pregrant macOS privacy permissions
or remove the normal Internet-download confirmation. The expected outcome is
successful Gatekeeper assessment, not the absence of every operating-system prompt.

### Automatic release publication

Desktop Release has one final publish job, owned by
[PublishDesktopRelease.ts](scripts/PublishDesktopRelease.ts). It runs on `main` in
the existing `release` environment after preparation, Windows, and both Mac builds
succeed. Dispatch only when that source is ready for public distribution. Existing
release-environment approval rules also apply to publishing. The built-in GitHub
token is supplied only to the publishing step; no personal token or website
credential is needed.

The job downloads artifacts from the current run, reserved version and source
commit. Each target selects its newest uploaded attempt independently, so **Re-run
failed jobs** can reuse earlier successful targets without rebuilding them. The
publisher checks exact filenames and final installer hashes against the signature
inventories, creates a new draft at the source commit, uploads all three targets,
and resolves the draft's numeric release ID before comparing GitHub's uploaded
asset names, sizes and SHA-256 digests with the local files. GitHub's REST lookup
by tag only returns published releases. It includes DMGs, ZIPs, the Windows
installer/blockmap, signature inventories and regenerated update manifests. It never rebuilds,
re-signs or overwrites an existing asset. A failure before publication keeps the
previous public downloads available and leaves any incomplete release as a draft.

Both signed platform workflows read `MAIN_VITE_UPDATE_FEED_URL` from the GitHub
`release` environment. Configure it as the repository's public Latest download
feed; missing or invalid feeds fail signed builds rather than disabling updates.
For production builds through Doppler, store the same public value in
`tro-local/prd`. A Railway API runtime variable cannot change this build-time
desktop setting. To configure Actions:

```sh
gh variable set MAIN_VITE_UPDATE_FEED_URL --repo ducnguyen67201/TroApp --env release --body 'https://github.com/ducnguyen67201/TroApp/releases/latest/download'
```

The final publisher marks a release Latest only after all installers and manifests
pass uploaded-asset verification. `latest.yml` describes the signed Windows
installer; `latest-mac.yml` includes Apple Silicon and Intel ZIP/DMG files. These
manifests use final byte counts and SHA-512 checksums, with installer URLs pinned
to the exact release tag. Builder metadata is replaced rather than trusted after
signing/stapling. Feed generation is deterministic so resume checks identical bytes.

Installed apps check at startup and every four hours. A newer version shows the
existing update action on the welcome screen or signed-in sidebar. Download and
restart require user actions, and restart waits until active work has stopped.
The updater uses full downloads, verifies checksums and retains native signature
verification; it rejects downgrades and prereleases. No GitHub credential ships in
the app. Development and local builds without a feed keep updates disabled.

Installations built before feed enablement, including 0.1.5, need one manual
installation of a new signed build. Publishing metadata cannot enable an updater
inside an already installed build that has no feed. Later releases can then be
discovered in-app. Test older-to-newer signed installs on Mac (both architectures)
and Windows before relying on unattended distribution; offline tests do not
exercise native installation or Gatekeeper/Authenticode on user machines.

Publication tags use `release-v<version>-<short-commit>-<run-id>-<attempt>`, separate
from the immutable `desktop-v*` version reservations. Reruns therefore preserve
published releases and incomplete drafts. `release.publish.stage` identifies the
last operation without raw command output or credentials;
`release.publish.command.failed` identifies the command/operation and numeric exit
code, and `release.publish.upload.rejected` distinguishes invalid metadata from
asset-count/hash mismatches without logging remote content.
`release.publish.completed` records the public release URL. After an interrupted
publish, inspect that attempt's draft/release before retrying. New workflow runs
reserve a new app version; retries within a run retain its reserved version.

To recover a fully uploaded draft, use the publisher with `--resume` in the original
run/attempt context and with that run's downloaded `verified-release` directory
and reserved package version:

```sh
pnpm exec tsx scripts/PublishDesktopRelease.ts --directory verified-release --resume
```

Resume skips draft creation and uploads, checks the complete local signature
inventories and remote hashes again, then publishes the same draft. A missing,
incomplete, changed, already published or wrong-commit release is rejected.
Rerunning a GitHub job uses the original run's checked-out source; a local publisher
fix is not picked up by **Re-run failed jobs**. Do not dispatch a new build to
recover already verified installers.

The marketing website reads TroApp's published GitHub Releases and caches its
selection for five minutes. Each platform selects its newest published stable
installer independently, falling back to a preview only if no stable installer
exists. No webhook, website commit or redeployment is needed. GitHub/API failures
can delay refresh while the website retains its previous cached selection. This
website selection is independent of the installed app's Latest update feed.

### Windows release from GitHub Actions

The **Windows Release** workflow is called by Desktop Release to build a signed
x64 NSIS installer from the reviewed source and shared reserved version. Desktop Release
validates the project once without cloud credentials, then Windows uses the GitHub
environment `release` and Azure OIDC to sign during packaging.
It retains verified build artifacts for 14 days; the final Desktop Release job
publishes them alongside the Mac installers once every platform succeeds. It does
not deploy the API; the final publisher updates the shared public feed. No separate release
branch or client secret is needed.

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
| `MAIN_VITE_UPDATE_FEED_URL` | Shared public HTTPS update feed; required                |

The workflow supplies `MAIN_VITE_APP_ENV=prod` and `TRO_SIGN_WINDOWS=true`, and reads
the update feed from the `release` environment in
[WindowsRelease.yml](.github/workflows/WindowsRelease.yml). Ordinary
local packaging keeps signing optional. Release builds use the shared reserved
version applied to `package.json`; local packaging uses the current checkout's baseline.
Azure signing settings stay in the packaging process and are not copied into app
metadata. The pinned electron-builder v26 uses `win.azureSignOptions`; its upstream
PowerShell signing module and hosted runner image are not completely pinned by
the pnpm lockfile.

After the workflow is merged into `main`, open Actions → Desktop Release → Run
workflow → main. Download the successful run's
`Tro-<version>-windows-x64-<sha>-<run-id>-<attempt>` artifact. It
contains `Tro-<version>-windows-x64-setup.exe`, its blockmap, a signature inventory,
and builder update metadata. The publisher regenerates the public manifest with
the verified installer hash and a release-pinned URL. Signing failures or invalid
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
is enabled. Windows teaching uses the patched native companion; hardware acceptance is not
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
  change OS default routing and verify the picker previews each selected input
  automatically. Hide or close the picker and verify tracks stop; return to the
  visible picker and verify preview resumes. Compare locally and verify cancel
  returns to the selected input's preview without overlapping captures.
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
