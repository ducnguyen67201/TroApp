# Mac permission onboarding

Status: implemented in Electron. The [interactive HTML prototype](PermissionsOnboarding.html) remains a visual reference; its simulated Settings window does not request real OS access.

## Flow

1. Before the first model request, Electron main starts the bundled `CuaDriver.app` and reads its permission status. Do not send a chat message, screenshot, or tool catalog to OpenAI while setup is incomplete.
2. After sign-in, if Accessibility or Screen Recording is missing or the driver's status is unknown, show setup before the chat workspace. Name **CuaDriver.app** as the app the person must enable.
3. **Ask for permission** invokes the fixed, bundled `cua-driver permissions grant` command from Electron main. Cua launches its app through LaunchServices and macOS presents its own permission prompts. The person may need to choose **Open System Settings** and enable CuaDriver in both lists. Tro cannot flip those switches.
4. Provide **Open Settings** as a fallback action for each permission. Electron main opens a fixed macOS Settings destination and falls back to the general Privacy & Security area if the specific pane link fails. System Settings is a separate macOS window, not content embedded in Tro. Do not accept a URL or executable path from the renderer.
5. On return to Tro or **Check again**, read the driver's status again. Treat `unknown` as unresolved. If macOS requires CuaDriver to quit and reopen after a grant, say so and recheck after it restarts.
6. Only after both grants are verified does Tro enter the workspace. Electron main rechecks before issuing a task session or obtaining the model gateway token. A failed verification leaves setup visible. No chat draft is collected during setup.

Do not repeatedly launch prompts on a timer. Read-only rechecks on window focus and an explicit button are enough. Windows has no equivalent macOS permission screen in this release; its driver capability and installer behavior still need a signed-install smoke test.

## Code ownership

- `src/contracts/DesktopPermissions.ts`: validated permission states and narrow bridge command/result schemas.
- `src/desktop/main/DesktopPermissions.ts`: owns the fixed Cua executable, status check, grant request, and Settings opening. `Main.ts` verifies the IPC sender.
- `src/desktop/preload/Preload.ts`: expose named `readDesktopPermissions`, `requestDesktopPermissions`, and `openDesktopPermissionSettings` methods only.
- `src/desktop/renderer/`: render the two statuses and recheck on window focus. The renderer never runs commands or chooses external URLs.
- `src/desktop/main/AgentChatController.ts`: gate the model credential and worker start on verified readiness.

The installed 0.30.4 driver supports `permissions status --json` and `permissions grant`. Cua's [installation guide](https://github.com/trycua/cua/blob/main/docs/content/docs/how-to-guides/driver/install.mdx) explains that the prompt registers CuaDriver but the person must enable each macOS switch, and that a restart can be required. Its [MCP tool reference](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/mcp-tools.mdx) distinguishes a read-only permission check from the host-side grant flow. Electron's [shell API](https://www.electronjs.org/docs/latest/api/shell) can open an external Settings destination from main; a pane-specific macOS Settings URL should be treated as a convenience with a fallback, not a stable permission API.
