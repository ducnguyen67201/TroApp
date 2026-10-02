# Desktop app updates

Tro has a full-width sidebar update button immediately above Settings. It appears when a newer release is available, downloads only after a click, shows progress, and changes to **Restart to update** after download. A failed check, download or install can be retried. The current window can keep working during download. Restart is blocked while an agent task, voice operation or microphone test is active. Copy is available in English and Vietnamese.

Updates are independent of Google sign-in. Installed macOS and Windows builds check at startup and every four hours. Development builds, unsupported platforms and builds without a configured release feed leave updates disabled. No simulated update state is shipped in the application.

## Release configuration

Set the public build setting `MAIN_VITE_UPDATE_FEED_URL` to your HTTPS release directory when running `pnpm package:desktop`, for example `https://downloads.example.com/tro/stable/`. Use the same environment for the complete build/package command. Credentials, URL queries and fragments are rejected. The address is embedded in the main bundle and the generated packaging configuration; users cannot change it through the renderer. An unset address leaves updates disabled. No hosting destination has been selected or created by this change.

`PrepareDesktopPackage.ts` adds a generic provider to the staged package only when the feed is supplied. `PackageDesktop.ts` retains `publish: 'never'`: packaging writes local installers and metadata and does not upload anything. Each release needs a higher version in `package.json`.

The packaging validator explicitly loads the same production `.env` files as electron-vite (`.env`, `.env.local`, `.env.production`, `.env.production.local`). A shell setting takes precedence. T3 Env validates the resolved value; it does not load these files itself. Use the standard production packaging command so the main bundle and updater metadata receive the same setting.

macOS builds now produce both DMG and ZIP targets. The ZIP is required for updating; the DMG remains the installer. macOS releases must be code signed, and distributed releases should also be notarized. Windows uses the existing NSIS installer. Configure production Windows code signing and verify the publisher identity across successive releases. Tro keeps the updater's signature/checksum validation enabled and disables web installers, prerelease updates and downgrades. See the [electron-builder v26 updater guide](https://www.electron.build/v26/docs/features/auto-update/).

Host the generated installers, ZIP archives and blockmaps under the configured HTTPS directory. Upload the release metadata (`latest-mac.yml` for macOS and `latest.yml` for Windows) only after its referenced files are present. The feed must be publicly readable without bundled credentials. Release artifacts must match the intended platform and architecture; use separate architecture directories and corresponding build settings if release metadata would collide. Publishing and signing remain explicit release operations.

## Ownership and shutdown

- `src/contracts/AppUpdate.ts` owns validated commands, snapshots, replies and public states.
- `src/desktop/main/updates/AppUpdateController.ts` owns transitions, duplicate-action prevention and restart admission through injected ports.
- `ElectronAppUpdater.ts` contains the `electron-updater` integration and validates third-party event payloads. It strips installer paths and diagnostics from public state, and turns off automatic download and install-on-quit.
- `Main.ts` checks the IPC sender and document, owns periodic checks, and follows the existing worker, voice, companion and embedded driver cleanup before calling `quitAndInstall`. New renderer operations are rejected once restart begins. A failed installer remains retryable in the current window.
- `Preload.ts` exposes named operations and validates every update reply/event. It exposes no generic IPC, update URLs or installer paths.
- `UseAppUpdate.ts` subscribes before reading and applies monotonic snapshot revisions so slow replies cannot replace newer progress. `AppUpdateButton.tsx` renders the sidebar action and native progress element.

Normal app quit does not install a downloaded update. The user must press **Restart to update**; their in-memory chat and drafts end with that restart, as with any app quit. Downloads can be reused from the updater cache on a later launch, after another check and explicit download action.

## Verification and remaining release checks

Unit tests cover lifecycle ordering, explicit actions, busy admission, retries, duplicate work, event validation, trusted IPC dispatch, stale snapshots, translation, sidebar placement and subscription cleanup. These tests use injected updater ports and synthetic bridge events with no update server or cloud credentials.

Before releasing, install a signed older build on each supported platform and architecture, host a signed newer build and its metadata, and exercise availability, download progress, network failure/retry, busy restart blocking and successful relaunch. Confirm that the relaunched version is newer, Google session storage remains intact, and the Cua driver/companion resources work. These installed-app and live-host checks cannot be replaced by unit tests or a source build.
