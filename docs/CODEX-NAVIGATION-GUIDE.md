# Codex navigation guide

Read README.md, AGENTS.md, and Architecture.md first. Tro is one pnpm root. Use exact-case imports and do not import sibling-repository source.

| Change               | Start here                                                                               | Verify                                                   |
| -------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| UI                   | `src/desktop/renderer/App.tsx`, `SettingsDialog.tsx`                                     | Renderer types and interaction                           |
| Microphone selection | `src/desktop/renderer/voice/UseMicrophones.ts`, `Microphones.ts`, `MicrophonePicker.tsx` | Inventory, ranking, local test lease and capture cleanup |
| Desktop capability   | `Preload.ts`, `Main.ts`                                                                  | IPC validation and sender restrictions                   |
| Public response      | `src/contracts/SystemStatus.ts`                                                          | API/client/contract checks                               |
| HTTP                 | `src/server/CreateApi.ts`                                                                | Versioned paths and route tests                          |
| Workflow             | `src/server/application` or owning feature                                               | Port-based unit tests                                    |
| Database             | `prisma`, `src/server/persistence`                                                       | Migration and adapter checks                             |
| Hosting              | `Dockerfile`, `railway.json`, `Deployment.md`                                            | Container/readiness; no automatic deployment             |
| Local agent          | `src/desktop/worker`, `src/contracts/AgentSession.ts`                                    | Worker startup, cancellation, IPC validation             |

`src/desktop/main/companion/DesktopCompanion.ts` owns desktop companion composition (`cursor` and `hud`), presentation startup and cleanup. HUD lifecycle state belongs in `CompanionHudController.ts`; transport belongs in `CompanionHudClient.ts`. `AgentChatController.ts` retains the shared cursor/task worker lifecycle. `EmbeddedDesktopDriver.ts` owns the main-process daemon and supplies both workers with its private endpoint; worker teardown must not stop that shared host.

Renderer/preload cannot import backend or main-process implementation. Contracts cannot import desktop/server implementation. Domain code cannot import frameworks, I/O, or persistence. Prisma belongs in backend persistence adapters and Prisma config. Environment modules are per process.

For desktop styling, `src/desktop/DesktopAppearance.ts` owns the shared palette and native window appearance. `src/desktop/renderer/Theme.ts` owns Mantine defaults and semantic tokens. `App.css` owns layout using those tokens. See [DesktopUi.md](DesktopUi.md) for the scaffold and state ownership.

Import shared contracts as `#contracts/SystemStatus.js` from either process. Keep imports within a feature relative; the alias is deliberately limited to contracts.

Desktop updates start in `src/desktop/main/updates/AppUpdateController.ts` and `ElectronAppUpdater.ts`, with public schemas in `src/contracts/AppUpdate.ts`. `src/desktop/renderer/updates` owns the sidebar action. Release feed configuration enters through `Env.ts` in desktop main and scripts; `PrepareDesktopPackage.ts` stages the generic provider. See [AppUpdates.md](AppUpdates.md).

`scripts/CheckBoundaries.ts` checks core ownership and filenames. Describe behavior, contract changes, migrations, and verification in review notes. State what is planned versus implemented. Do not publish, push, deploy, or start paid work without authorization.

[MicrophoneSelection.md](MicrophoneSelection.md) maps microphone selection, recommendations, capture ownership and permission boundaries. Device selection belongs in the desktop voice feature; the server receives only the existing transcription protocol.

Local comparison starts in `UseMicrophoneTests.ts` and `MicrophoneTestCapture.ts`; `MicrophoneMeasurementCollector.ts` owns pure statistics; `MicrophoneMeasurements.ts` validates the worklet contract. `MicrophoneTestLease.ts` owns main-process exclusivity; `src/contracts/MicrophoneTest.ts` owns its narrow bridge. Use `scripts/CheckMicrophonePackage.ts` for artifact inspection and `docs/MicrophoneHardwareChecks.md` for signed hardware release checks.

## Worker and test navigation

Start with [worker ownership](../src/desktop/worker/README.md). Teaching business rules live in `worker/teaching`, screen-change scheduling in `worker/observation`, action verification in `worker/execution`, SDK composition in `worker/agent`, and native adapters in `worker/cua`. Worker entry points stay at the root.

Tests mirror each production folder under `test/`; for example `src/desktop/worker/teaching/TeachingPresenter.ts` is covered by `test/desktop/worker/teaching/TeachingPresenter.test.ts`. Teaching-flow fixtures are in `test/desktop/worker/teaching/flow`. Vitest runs unit and integration tests separately; TypeScript and ESLint cover both trees.

Browse the [documentation index](README.md) for grouped agent, teaching, and companion specs.

HUD voiceover is composed through `AgentChatController` and
`main/voiceover/VoiceoverController.ts`. `Main.ts` owns authenticated streaming,
playback acknowledgments and microphone interruption. The backend feature is
`server/features/voiceover`, with allowance in `PrismaVoiceoverAllowance.ts`.
See [HUD voiceover engineering](companion/HudVoiceoverEngineering.md).
