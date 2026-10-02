# Microphone packaged release checks

The picker, local comparison and editable ranking are implemented. Automated tests use synthetic devices. Physical microphones, OS permission prompts, reconnects and release signing require the real target operating systems and hardware. A unit-test pass cannot replace these checks.

## Reproducible artifact checks

After final source validation:

```sh
pnpm exec tsx scripts/PackageDesktop.ts --dir
pnpm check:microphone-package release/mac-arm64/Tro.app
# On Windows, supply the generated unpacked directory instead:
pnpm check:microphone-package release/win-unpacked
```

Packaging never publishes. The checker reads the actual ASAR through an isolated Electron runner and checks both voice and test worklet assets plus narrow test bridge wiring. On macOS it also checks the packaged microphone usage text and signed audio-input entitlement, and identifies an ad hoc signature without calling it release signing. It does not boot auth/model/driver workers, request a microphone, change TCC/privacy settings or log device labels/audio. Keep the default user profile and existing grants intact.

On this Mac the local packager has no Developer ID identity, so it skips signing. For local artifact inspection only, apply the declared entitlements with an ad hoc signature to the generated app (never a distributed release):

```sh
codesign --force --sign - --entitlements scripts/DesktopEntitlements.plist release/mac-arm64/Tro.app
pnpm check:microphone-package release/mac-arm64/Tro.app
```

Without the entitlement, the checker fails rather than marking the unsigned artifact ready. An ad hoc development app does not verify Developer ID, notarization or clean-install permission behavior. On Windows, assets can be inspected locally, but the application must still be exercised on Windows with its release identity and privacy controls. Use the regular product login on a test account for interactive checks; never insert credentials or a production bypass into the app.

## Hardware matrix

Record OS/app version, architecture, signature identity category, permission starting state, device kind, expected behavior and observed pass/fail. Do not retain sound, transcripts, credentials or device IDs/names in the report. Test at least built-in, USB, Bluetooth and virtual inputs on each platform.

| Scenario                                   | Expected evidence                                                                                              | macOS release build               | Windows release build             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| Clean install; microphone grant            | Host app purpose is correct; exact chosen input supplies a local test; tracks close afterward                  | Requires interactive hardware run | Requires interactive hardware run |
| Denial and recovery                        | Test fails without fallback; OS grant/retry succeeds without sending a task                                    | Requires interactive hardware run | Requires interactive hardware run |
| Idle dialog and refresh                    | No microphone indicator, only inventory access                                                                 | Requires interactive hardware run | Requires interactive hardware run |
| Local test quiet/speech                    | Two-second quiet and four-second phrase prompts; finite measurements; no task or transcription request         | Requires interactive hardware run | Requires interactive hardware run |
| Cancel, close, sign-out, hide, sleep/lock  | Indicator stops; late setup closes; no partial result, task or orphaned lease                                  | Requires interactive hardware run | Requires interactive hardware run |
| Hold shortcut during a test                | No voice preparation or second stream; a fresh hold works after the test and keys are released                 | Requires interactive hardware run | Requires interactive hardware run |
| Unplug while opening/testing/holding       | Exact input fails; no OS fallback; tests/results clear on device changes                                       | Requires interactive hardware run | Requires interactive hardware run |
| Bluetooth reconnect                        | No orphaned stream or stale result; explicit selection recovered only for the same ID                          | Requires interactive hardware run | Requires interactive hardware run |
| Ranking persistence and reset              | Preference survives restart; absent IDs return; selected route and Auto-detect unchanged                       | Requires interactive hardware run | Requires interactive hardware run |
| OS default change                          | Auto-detect follows OS; explicit choice remains exact                                                          | Requires interactive hardware run | Requires interactive hardware run |
| English/Vietnamese, keyboard, small window | Controls and table usable; focus returns on modal close; up/down buttons have device-specific accessible names | Requires interactive hardware run | Requires interactive hardware run |

## Current execution evidence

The October 2 local run passed lint, formatting, type checking, 362 unit tests, the desktop/API build and seven disposable-PostgreSQL integration tests. An isolated Electron preview exercised the built local-test worklet using generated quiet/speech tones, displayed scalar results, completed cleanup, and persisted ranking without switching the selected input. Its bridge and devices were synthetic; it did not exercise physical hardware or production OS permission admission. The macOS packager produced an ARM64 app and reported zero valid signing identities. The package checker initially rejected its missing audio entitlement; an ad hoc local signature is needed for metadata inspection. No Developer ID or notarized release evidence is available. This checkout is on macOS; no Windows host is attached. Final local command results and any packaged artifact run are reported at handoff. Signed Mac/Windows device runs remain unverified until the matrix above is exercised. Installer distribution and paid provider testing are outside this local implementation.
