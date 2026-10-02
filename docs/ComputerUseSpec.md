# Local computer-use tasks

Status: text input, Google sign-in in the system browser, the backend model gateway, and an on-demand local agent worker are implemented. Each message is a fresh task. Live Google OAuth requires provider credentials and end-to-end validation; OpenAI/Cua GUI actions, Windows installation, signed macOS behavior, and production operations also need validation.

## Where each part runs

```mermaid
flowchart LR
  UI[React task UI] --> PRELOAD[Named preload bridge]
  PRELOAD --> MAIN[Electron main: login and worker lifetime]
  MAIN --> WORKER[On-demand utility process]
  WORKER --> SDK[OpenAI Agents SDK]
  SDK --> CUA[Cua Driver MCP process]
  CUA --> DESKTOP[Visible desktop]
  SDK --> GATEWAY[Tro backend model gateway]
  GATEWAY --> OPENAI[OpenAI Responses API]
  MAIN --> AUTH[Tro backend authentication]
  AUTH --> PG[(PostgreSQL)]
```

The user signs into Tro with Google in the system browser. Google is the supported sign-in flow; public email/password signup and sign-in are disabled. Better Auth returns a short-lived code to Electron through the registered app protocol; Electron main exchanges it for a session. The backend keeps `OPENAI_API_KEY` and the Google client secret, and issues a 15-minute model-only token to Electron main. Main passes that token to the local utility process, where the Agents SDK calls Tro's model gateway. React receives neither the model token nor the provider keys. The gateway limits the model and output tokens but does not cap or count model requests per account or per day. Historical ModelUsage records remain in the database and no longer affect requests. The model runs remotely; screen observations or tool results sent to it leave the computer.

Cua Driver is included in packaged desktop builds and exposes its current tools over a private MCP connection. During development, Tro downloads the pinned, SHA-256-verified release once. On macOS, Tro requests Accessibility and Screen Recording in its own main process. Once both grants are verified, main directly starts a private embedded Cua daemon and supplies its MCP command, environment, and socket to the worker. The driver inherits the host's permissions and never launches a second app through LaunchServices. The pinned native SDK and executable are shipped outside ASAR. Signed packaged builds use Tro; the standard development launcher uses a separate branded Tro identity. The Agents SDK discovers the tool catalog and chooses actions. Tro's standing instruction is [ComputerUseInstructions.ts](../src/desktop/worker/ComputerUseInstructions.ts). Tro does not maintain a wrapper for each Cua action. The agent can take general GUI actions in accessible apps. This prototype has no per-action approval UI, though Cua's runtime permission mode may apply. Push-to-talk is implemented as described in [VoiceInputSpec.md](VoiceInputSpec.md); class context is not implemented.

Some Cua tools declare open-ended JSON arguments. [LoggedCuaServer.ts](../src/desktop/worker/LoggedCuaServer.ts) adjusts their advertised top-level schema before the Agents SDK reads it, avoiding a repeated strict-schema conversion warning. The SDK still sends these tools to the model in non-strict mode with open arguments; Cua remains the owner of tool execution. Tro does not add browser-specific tools or call macOS LaunchServices to carry out user tasks. Cua provides `launch_app`, `list_windows`, `bring_to_front`, `get_window_state`, `browser_prepare`, `get_browser_state`, and `browser_navigate`. The agent first looks for existing windows across all Spaces and displays, reuses a matching tab or window, and focuses that exact window. A current-Space-only or PID-filtered empty list does not establish that an app is absent. `browser_navigate` requires a tab identified by Cua; `browser_prepare` only establishes browser control. Desktop hotkeys are a fallback after the target window is confirmed.

The worker defines an immutable natural-language goal before desktop mutations and collects observations with target IDs and mutation revisions. When the main agent believes the request is fulfilled, it calls `verify_task`, which delegates to TaskHarness and invokes a separate read-only SDK agent. The main agent waits while that verifier judges the original request against a worker-built evidence packet and targeted observations, excluding actor claims and prior verdicts. CompletionGate checks a consistent decision, real evidence, capture age, supersession and the stored verdict before exposing final results. Any desktop use requires task mode and verification; tool-free conversation still uses response mode. Verification is requested explicitly rather than run after each action or in a concurrent observer loop. At most two verification attempts and one optional main-agent continuation use the same goal, history, locale and shared task limits. Typed and voice results expose succeeded, partial, blocked or unverified outcomes. See [TaskCompletionSpec.md](TaskCompletionSpec.md) for implementation ownership, costs and validation limits; live multi-display behavior still needs macOS/Windows testing.

The MCP bridge includes Cua structured metadata as a text content block alongside screenshots and summaries. Exact window IDs, capture geometry and refusal details reach the SDK without entering logs. Host lifecycle calls retain their original native result. Teaching remains receipt-based: a matching V2 native receipt proves only that the demonstration displayed, and takeover or failure ends teaching without execution recovery. Both paths share the main-owned embedded driver and report progress to the companion HUD.

## Task and process lifetime

| Event                               | Behavior                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App opens                           | Better Auth's Electron client restores the Tro login cookie from OS-backed `safeStorage` when available. No agent worker or Cua connection starts.                |
| First message                       | Main creates an IPC session ID, obtains a scoped gateway token, starts the utility process and Cua MCP, then sends the text to `run(agent, message, …)`.          |
| Later message                       | The worker may stay warm, but the next `run` receives only that message. It does not receive the previous messages, screenshots, tool calls, or an SDK `Session`. |
| Completed task                      | React displays the user's text, answer and explicit task outcome in memory. Tro does not save a conversation file or send that display history back to the model. |
| 15 minutes idle                     | Main closes Cua MCP and stops the worker. An active task is not stopped by the idle timer.                                                                        |
| Expired gateway token               | Before another task, main obtains a fresh token and restarts the worker. No history needs restoring.                                                              |
| New task, sign-out, or window close | New task clears the displayed messages and stops the current worker. Sign-out also clears the login cookie. Closing the app discards the displayed messages.      |

The session ID coordinates IPC and worker shutdown; it is not a persistent conversation ID. Creating an `Agent` configures model, instructions, and Cua tools. Without passing a `Session` to `run`, each call starts with fresh model context. A task can still involve several model/tool steps within its own `run` call. If a task fails or is interrupted, Tro does not replay its computer actions automatically; the user can retry their text manually.

Each typed instruction snapshots `useLocale().locale` when submitted. A voice instruction keeps its capture locale through final transcription and agent submission. Both renderer-to-main and main-to-worker turn contracts require the existing `DesktopLocaleSchema` (`vi` or `en`); no agent language setting or environment variable is added. The worker creates a fresh agent for each task while retaining its Cua connection. `createComputerUseInstructions(locale)` appends the selected reply language to the standing instructions and directs explanations, clarification questions, and summaries to use it, unless the user explicitly requests another output language. A recovery continuation uses that same agent and locale. Changing the app language during a task takes effect on the next instruction, including when the worker remains warm. URLs, code, identifiers and proper names retain their appropriate spelling. Model compliance still requires a live check.

## Code ownership

```text
src/contracts/AgentSession.ts, AuthSession.ts, DesktopBridge.ts
src/desktop/renderer/UseComputerUse.ts    # Shared sign-in and in-memory task state
src/desktop/renderer/ComputerUsePage.tsx  # Workspace input and message display
src/desktop/preload/Preload.ts              # Named validated IPC operations
src/desktop/main/AuthClient.ts              # Google browser sign-in, encrypted cookie in main
src/desktop/main/AgentChatController.ts     # On-demand worker and idle stop
src/desktop/main/AgentWorkerClient.ts       # Utility process and reply correlation
src/desktop/worker/StartAgentWorker.ts      # Agents SDK client configuration
src/desktop/worker/ComputerUseTaskRunner.ts # One-run tasks and Cua MCP lifetime
src/desktop/worker/ComputerUseInstructions.ts
src/server/persistence/AuthDatabase.ts      # Better Auth/Prisma adapter
src/server/auth/RegisterAuthRoutes.ts       # Fastify /api/auth/* adapter
src/server/auth/RegisterModelGateway.ts     # Scoped token and Responses proxy
prisma/schema.prisma                         # Accounts, sessions, usage
```

To try it locally, apply migrations, set a unique `AUTH_SECRET`, backend `OPENAI_API_KEY`, and Google OAuth web client credentials, and start the API and desktop. Register `http://127.0.0.1:3000/api/auth/callback/google` with Google. The development launcher fetches Cua Driver automatically; on macOS, grant Screen Recording and Accessibility to Tro. Sign in with Google and send a text task. The account flow currently has no MFA or hosted deployment. When OS encryption is unavailable in an unsigned development build, the cookie remains in memory and login is not restored after restart.

Before public release, validate actual Cua MCP startup, screenshot/action calls, cancellation during a tool call, gateway streaming, packaged worker startup, and OS permissions on both platforms. Add account recovery and verification or another identity provider, production abuse controls and billing, and installer signing. Automated checks use a fake provider response and do not execute GUI actions.

## References

- [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- [Better Auth Electron integration](https://better-auth.com/docs/integrations/electron)
- [Cua Driver MCP integration](https://cua.ai/docs/how-to-guides/driver/connect-your-agent)

## Native V2 teaching guidance

Show me uses host-bound V2 cursor guidance. The native companion approaches,
traces, holds and clears one cue at a time, then returns to pointer following.
Passive pointer movement is allowed. Click/key/scroll takeover is terminal for
the task; teaching has no automatic recovery continuation. A typed `teaching`
result carries demonstrated, explained, needs_input, canceled or failed status through the
existing main/preload and voice boundaries. Demonstrated requires native receipt
evidence, independent of desktop-action verification. Host lifecycle tools remain
private and the model cannot omit V2 to select legacy behavior. See
[CursorCompanionEngineering.md](CursorCompanionEngineering.md) for implemented
modules, timings, compositor evidence and primary-display limits.

Teaching also answers general how-to questions without requiring a visual guide.
Every Show me run starts with a forced `get_desktop_state` tool choice, released
by the SDK after the first tool call. The model therefore receives desktop context
before deciding whether the request needs a guide, explanation or clarification.
References such as "here" or "this app" are resolved from that context instead of
assuming the student means Tro's own chat. An interface introduction prompts an
ordered tour of two to four observed controls, with matching explanations.
Standing instructions use Markdown sections and short bullets, with separate
teaching examples and an appended reply-language section. See
[AgentPromptResearch.md](AgentPromptResearch.md) for the public-source comparison
and proposed live evaluation cases.
The prompt chooses a useful beginner path for broad requests, gives concrete steps
and a checkpoint, and asks a focused clarification only when the missing information
prevents progress. Procedures in an identifiable app prompt screen observation and
a cursor cue for the first visible, actionable control, even without a separate
request to highlight it. Abstract learning steps remain text. If no target is
observable, general instructions remain useful; an explicitly requested guide may
instead need a specific student action to expose the target. Screen-specific
instructions require observation; conceptual explanations need no further screen
inspection after the initial capture. For a visual guide, the agent must
obtain a fresh capture, call `show_cursor_sequence` and await its native receipt
before returning the final answer, which ends the run. The model returns a
validated reply purpose and answer.
The worker preserves explanations as `explained` and specific questions or required
student actions as `needs_input` with an optional answer. Legacy results without an
answer retain deterministic localized copy. A guide claim without receipts still
cannot become `demonstrated`; pending, failed and canceled guides suppress model
prose. Each next message remains a fresh task, so requested follow-up information
should identify the app or screen rather than relying on retained chat context.
