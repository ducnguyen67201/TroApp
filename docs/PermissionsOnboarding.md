# Mac permission onboarding

Status: implemented in Electron. The [interactive HTML prototype](PermissionsOnboarding.html) remains a visual reference; its simulated Settings window does not request real OS access.

## Flow

1. Before the first model request, Electron main reads its own host permission status through the pinned native Cua SDK without starting a daemon or presenting a prompt. Do not send a chat message, screenshot, or tool catalog to OpenAI while setup is incomplete.
2. After sign-in, if Accessibility or Screen Recording is missing or the host's status is unknown, show setup before the chat workspace. Name **Tro** as the app the person must enable. Plain development Electron may appear as **Electron**, and its grants do not transfer to a signed installed Tro.
3. **Ask for permission** invokes the native SDK's `requestMacOsPermissions()` in Electron main after readiness. macOS presents permission UI for the importing host. Tro cannot flip those switches. No `cua-driver permissions grant` child or LaunchServices driver launch is used.
4. Provide **Open Settings** as a fallback action for each permission. Electron main opens a fixed macOS Settings destination and falls back to the general Privacy & Security area if the specific pane link fails. System Settings is a separate macOS window, not content embedded in Tro. Do not accept a URL or executable path from the renderer.
5. On return to Tro or **Check again**, read the host's status again. Treat `unknown` as unresolved. If macOS requires Tro to quit and reopen after a grant, say so and recheck after it restarts.
6. Only after both grants are verified does Tro enter the workspace. The first task starts an embedded daemon as a direct child of main and uses its private MCP endpoint. Old standalone CuaDriver grants are not accepted as Tro grants. Electron main rechecks before issuing a task session or obtaining the model gateway token. A failed verification leaves setup visible. No chat draft is collected during setup.

Do not repeatedly launch prompts on a timer. Read-only rechecks on window focus and an explicit button are enough. Windows has no equivalent macOS permission screen in this release; its driver capability and installer behavior still need a signed-install smoke test.

The installer contains one Tro app, and one setup button requests the required desktop access. macOS still controls Accessibility and Screen Recording as separate grants; bundling cannot combine those into one OS permission. Both Settings entries belong to Tro. Voice input additionally requires microphone access.

## Code ownership

- `src/contracts/DesktopPermissions.ts`: validated permission states and narrow bridge command/result schemas.
- `src/desktop/main/DesktopPermissions.ts`: owns host status checks, native grant requests, and fixed Settings destinations. `Main.ts` verifies the IPC sender.
- `src/desktop/main/EmbeddedDesktopDriver.ts`: owns the private daemon, startup gate, endpoint generation, and native handle cleanup. Worker teardown stops the daemon; unexpected daemon termination invalidates the worker.
- `src/desktop/main/LoadCuaSdk.ts`: loads the pinned native SDK from a physical resource tree in packaged builds.
- `src/desktop/preload/Preload.ts`: expose named `readDesktopPermissions`, `requestDesktopPermissions`, and `openDesktopPermissionSettings` methods only.
- `src/desktop/renderer/`: render the two statuses and recheck on window focus. The renderer never runs commands or chooses external URLs.
- `src/desktop/main/AgentChatController.ts`: gate the model credential and worker start on verified readiness.

The pinned 0.30.4 [Cua embedding guide](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md) describes host permission ownership, direct daemon spawning, private sockets, and `host` attribution. The SDK's permission primitives execute in the importing process. Launching through `open -a` creates a separate responsible app and defeats host inheritance. A changed Screen Recording grant can require a full host relaunch before capture works.

Automated tests cover read-only status, explicit host permission requests, startup gating, private MCP wiring, identity selection, and daemon cleanup. A signed installed Tro still needs an interactive macOS test confirming the actual Settings entry, grant/relaunch flow, screenshot, and accessibility read. Existing CuaDriver Settings entries are left untouched.
