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

The desktop build includes a pinned Cua Driver release. The development launcher downloads and verifies that release once before starting Electron. On macOS, Tro checks Screen Recording and Accessibility after Google sign-in and guides you to enable Tro in System Settings before showing chat. Tro requests these permissions in its own main process and starts a private embedded Cua daemon only after both grants are verified. The standard macOS development launcher and installed builds display Tro; their permission grants remain separate. With the macOS companion installed, Tro starts a local pointer-following worker after permission setup without model credentials or requests. It stays connected while the signed-in window is open. Without the companion, Tro starts the worker on the first task and keeps it warm for 15 minutes after a completed task. Each message has fresh agent context; only the current app window displays its messages, and they disappear when it closes. Model calls and screenshots sent to OpenAI require network access and may incur charges. See [ComputerUseSpec.md](docs/agent/ComputerUseSpec.md) for details and validation limits.

A per-task harness gates desktop completion: task replies distinguish succeeded, partial, blocked and unverified results after the main agent explicitly requests a read-only verification agent. Current evidence from both agents is retained only in task memory. See [ComputerUseSpec.md](docs/agent/ComputerUseSpec.md) and [TaskCompletionSpec.md](docs/agent/TaskCompletionSpec.md) for details and validation limits.

Voice input starts automatically after signing in: hold Command + Control on Mac or Control + Left Alt on Windows, speak, and release to send the final transcript to the agent. It uses GPT Live Transcribe through the authenticated backend and follows the existing English/Vietnamese language choice. The companion HUD shows voice capture and task progress; the workspace has no separate voice panel. If the global shortcut is unavailable, use typed messages until OS access is restored and you sign in again. Development startup applies the transcription migration automatically; hosted releases use the normal reviewed migration workflow. Backend defaults allow one capture at a time and 3,600 audio seconds per account per UTC day. See [VoiceInputSpec.md](docs/VoiceInputSpec.md) for implementation and live/packaged verification limits.

Choose an input from **Microphone** in the app header or Settings. Auto-detect follows your computer settings; a specific choice is saved locally. Tro suggests recognized wired or built-in inputs using device-name hints, with explanations for wireless/virtual inputs. Use **Edit ranking** to save your preferred order, or **Compare microphones** to run a six-second local quiet/speech test for each input. Tests show levels, clipping and startup time without uploading or saving audio. Ranking never changes the selected route. Missing explicit choices never silently switch to another microphone. See [MicrophoneSelection.md](docs/MicrophoneSelection.md) for engineering details and hardware checks.

## Ownership

| Folder          | Owns                                                               |
| --------------- | ------------------------------------------------------------------ |
| `src/desktop`   | Electron main, preload, React, local agent worker, Cua MCP client  |
| `src/contracts` | Runtime schemas and public response types                          |
| `src/server`    | API composition, application services, database ports/adapters     |
| `prisma`        | Schema and versioned migrations                                    |
| `scripts`       | Build tools and validation command entry points                    |
| `test`          | Unit/integration tests mirroring `src`, and teaching-flow fixtures |
| `docs`          | Architecture, development workflow, deployment decisions           |

See the [documentation index](docs/README.md) and [worker ownership map](src/desktop/worker/README.md) for feature navigation.

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

## Cursor guidance

Run `pnpm build:cua` on macOS to build the pinned companion-enabled Cua Driver,
then run `pnpm dev:desktop`. Allow desktop permissions for Tro.
Select **Show me** to demonstrate circles, arrows, selections and drag/click
previews while the student controls the real pointer. **Do it for me** uses
ordinary Cua actions. The companion follows while idle after permission setup.
Esc cancels the lesson and returns to idle following. V2 guides approach, trace,
hold and clear each cue; you can move your pointer while watching. Clicking,
typing or scrolling ends the current preview, then the same lesson observes again
and guides the next reachable step until its original goal is visibly reached.
This first adapter supports the primary macOS display. See
[CursorCompanion.md](docs/companion/CursorCompanion.md) for setup, boundaries and limits.

The macOS companion includes a compact voice bar with live audio levels,
transcription/submission transitions and actual task progress. `DesktopCompanion`
composes cursor and HUD behind one main-process entry point. Both workers share
Tro's embedded driver endpoint, while the HUD transport survives task handoffs.
See [CursorCompanionVoiceBarPlan.md](docs/companion/CursorCompanionVoiceBarPlan.md).

Teaching orchestration checks: `pnpm test:teaching` (local scripted flow) and `pnpm test:teaching:native` (also verifies the real macOS capture boundary). See [TeachingFlowContract](docs/teaching/TeachingFlowContract.md) for coverage and manual acceptance.
