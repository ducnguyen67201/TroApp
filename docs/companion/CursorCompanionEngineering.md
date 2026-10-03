# Cursor companion engineering

The implemented [teaching observation design](../teaching/TeachingObservationDesign.md) extends
interactive lessons with bounded native screen-change monitoring and fresh SDK
continuations on the primary macOS display.

The native V2 implementation follows the reviewed
[guidance specification](CursorCompanionGuidanceSpec.md). Tro ships the pinned
Cua source plus `driver-patches/CursorCompanion.patch`; no sibling source or
Electron presentation window is used. The local build version is `0.30.4-tro.15`.

See [TeachingCompanionPlan](../teaching/TeachingCompanionPlan.md) for the implemented message
presenter, frozen goal criteria, local student waits and locale changes.

## Ownership

`ComputerUseTaskRunner` admits a fresh host-generated task epoch before running
the Agents SDK. `present_teaching_step` admits a localized message and expected
result through the lesson context before optional native playback.
`LoggedCuaServer` hides direct cue tools, pins `presentation_version: 2`, rejects
identity overrides and concurrent calls during
a demonstration, validates receipts, and aborts the SDK on a terminal outcome.
`CuaCompanionClient` owns the native lease and host-only task admission/release.
Teaching instructions are separate from execution instructions. Teaching never
enters the execution task's bounded recovery continuation.

Cua's `CursorCompanion` composes capture validation, a pure planner, input
observation and the existing overlay. Native `companion_guidance.rs` owns V2
playback; `cursor-overlay/guidance.rs` owns bounded geometry, timings, frame
fences and per-step evidence. Existing `companion.rs` and the isolated legacy
playback path retain V1 compatibility for clients outside Tro's teaching mode.
These modules do not import desktop input executors.

## Desktop composition

The [voiceover engineering record](HudVoiceoverEngineering.md)
describes the chat-composed voiceover controller, private native installed-message
reader, authenticated Tro-to-ElevenLabs streaming and bounded renderer audio
playback. Provider credentials and usage admission stay on the backend. Snapshot
renewals and final drawing receipts never trigger another speech generation.
Audio interruption and microphone admission use a confirmed local playback stop.
Voiceover is wired locally; live provider and signed playback acceptance remain.

`DesktopCompanion` is the Electron main entry point with `readonly cursor` and
`readonly hud`. It composes explicit presentation ports; `AgentChatController`
continues to own the cursor/task worker. `CompanionHudController` reduces voice,
meter and task progress into presentation snapshots without capturing audio or
submitting tasks. Capture and session identities reject late updates.

`EmbeddedDesktopDriver` owns one cached native endpoint. The independent agent
and HUD utility workers lease connections to that endpoint; disposing a worker
closes its session without stopping the daemon. Unexpected daemon exit notifies
both clients. Only main stops and destroys the host during app shutdown.
`CompanionHudClient` coalesces snapshots, replays the latest state after bounded
reconnection and fences startup against sign-out. Native session cleanup and
bounded leases remove orphaned HUDs. Private group binding connects the HUD to
Tro's cursor; model tool discovery and invocation cannot access HUD controls.

The native compositor draws an 88 × 22 logical-point bar beneath the 9 × 10
pointer. Its waveform consumes finite amplitude values from existing PCM capture,
with native smoothing and crossfades. Voice input remains the sole transcript
submitter. The V2 `demonstrated` outcome shows completion; `needs_input`,
`canceled` and `failed` retain distinct HUD states. Success never derives from
model prose alone. Reduce Motion also applies to HUD animation.

## Playback and rendering

Each sequence compiles approach, trace, hold, fade/clear and return phases before
admission. Approaches use 900 logical points/second, clamped to 250–1200ms, and
skip coincident points. Trace lasts 200–5000ms. Holds default to 1100ms with a
500–2000ms range. Fade lasts 350ms and final return lasts 700ms. All phases count
toward the 15-second budget. There are at most eight steps, with no gesture queue.
The watchdog is the compiled duration plus two seconds.

An atomic `GuidanceFrame` carries the pointer hotspot, one cue, cue opacity,
visibility, pressed appearance, generation and revision. Pointer/cue updates
share one latest-frame mailbox. The platform also coalesces pending main-queue
images. Playback waits for each frame acknowledgment, preserving phase endpoints
and clear/return barriers; host release reserves the writer until its clear is
acknowledged. Following never writes during playback or release.

The renderer stamps receipts after installing the image in CALayer on the main
queue. These are compositor installation receipts, not physical display scan-out
receipts. Every callback checks the shared generation fence while installing the
image; stale generations cannot restore a retired mark. During teaching the Tro
badge is hidden and idle fading is suppressed, preserving the same complete cue
through its hold. The small white/blue pointer retains its existing size.

Cue paths are filtered after conversion to `f32` destination pixels. Consecutive
endpoints less than 0.01 pixel apart are omitted, accumulating distance from the
last retained endpoint. Empty and coincident initial prefixes therefore wait for
a drawable segment instead of triggering tiny-skia's `path stroking failed`
warning. Horizontal and vertical strokes remain valid. Pointer drawing and frame
acknowledgments still proceed while a cue has no drawable length. Native regression
tests cover initial circle prefixes, duplicate points, pixel precision, 1×/2×
scales and unchanged pointer pixels/receipts.

Each step needs an intermediate trace acknowledgment, a complete cue acknowledgment
and a full hold measured from the complete cue's compositor timestamp. Gaps over
150ms fail presentation, including an initial unacknowledged frame. The final
clear/return acknowledgment cannot replace missing step evidence. Reduce Motion
skips travel and tracing but still requires the complete cue and full hold. The
platform reads Apple's [Reduce Motion preference](https://developer.apple.com/documentation/appkit/nsworkspace/accessibilitydisplayshouldreducemotion)
on the main queue; an explicit native reduced-motion setting is also supported.

## Task evidence and cancellation

V2 requires a fresh session-bound primary-desktop capture at admission. It keeps
checking retained capture validity and primary-display geometry during playback;
ordinary admission age does not expire a running sequence. Coordinates are
normalized capture fractions, mapped to logical display points locally.

`TeachingCapture.ts` retains the latest primary capture ID and image-size option.
Before every grounded cue, the MCP bridge calls the host-only
`refresh_cursor_guidance_capture` tool. Native code compares decoded RGB pixels
inside the complete proposed cue rectangle plus 32 screen points of context,
using the session-owned original and one fresh capture. Unrelated background
animation can change while a stable target is renewed. Changed target pixels,
geometry or unavailable original captures refuse playback; failed reads and
invalid comparison output latch a technical failure and abort the SDK segment.
Input and geometry are checked on both sides of the comparison. Native five-second
admission and receipt fences remain enforced. No extra model turn is required.

The comparison returns no images; screenshots and capture IDs stay out of logs.
`cua.guidance.capture_refreshed` reports capture age, comparison duration and
`validationReason`. Exact region equality is conservative: a caret or animation
within the target can still refuse renewal. Tests cover delayed and fast models,
background changes, target pixels and full paths, geometry, failed reads, input
during renewal, private tool filtering and receipt settlement. Real model target
choice and visible macOS playback require manual acceptance.

Passive real mouse movement is allowed while watching. Clicking, typing or
scrolling latches `user_takeover` for the native preview epoch. `TeachingTaskRunner`
releases that epoch, keeps the original request and SDK history, and begins a new
epoch whose first model call must observe the desktop. An interrupted preview
never gains a completed receipt. Esc cancels the lesson. Session loss, lease expiry and
failures end it as failed; renewing the lease cannot revive a canceled epoch.

Tro independently tracks guidance receipts and desktop-action verification. A
native receipt must match the current task, dispatched step count, V2 version
and an unused sequence identity. Model prose, observation, or `verify_state`
cannot create guidance evidence or clear a guidance failure. The SDK receives
both screenshots and Cua structured metadata; neither is logged in ordinary logs.

The public bridge carries `kind: teaching` with a typed outcome. `demonstrated`
requires positive receipts and successful host release. The model reply schema
accepts only `guide` or `needs_input`; the public bridge rejects explanation-only
results. `needs_input` carries a specific question when the model requests input; a guide claim with no
receipt retains the deterministic fallback. Canceled/failed results carry a reason and display
deterministic English/Vietnamese copy rather than a model completion claim.
Typed and voice replies share this rendering path. Teaching always aims to show
something on screen or asks one focused question needed to do so, including for
conceptual and text-only requests. It requires observation before claiming
anything about the current screen.

Stop closes the private transport immediately because upstream stdio dispatch
serializes calls. Native session-ending checks stop playback before deferred
session cleanup. Sign-out/window close remove the native session and lease.
V1 retains its old pointer-movement cancellation for explicit legacy clients.

## Extension and limits

The current native teaching adapter supports the macOS primary display. The
same controller/planner separation allows additional display/platform adapters
without a service or event bus. Programmatic content changes inside an app are
not semantically tracked; the agent must observe before each new sequence and
after focusing an app. App focus stays a separate observed Cua operation.
Native Pause/Resume is deferred; the HTML preview controls are review controls.

`pnpm build:cua` verifies the pinned upstream commit, applies the complete patch
in an isolated checkout, runs native companion tests and stages an ad-hoc signed
executable with its runtime libraries. Packaging verifies patch/executable hashes.
Electron main's embedded Cua host owns permission attribution and daemon lifetime;
companion-only and credentialed worker starts both receive its validated private
MCP endpoint. Development uses Electron's identity; packaged builds use Tro.
The standalone app launcher and daemon permission parser have been removed. Public
signing and notarization remain release work. Unit tests cover host evidence,
version policy, takeover, SDK completion, UI outcomes, geometry, render fencing,
trace stalls and hold evidence; a live desktop smoke check is still needed for
hardware presentation and OS permissions.

## Interactive lesson progression

`TeachingReply.nextStep` distinguishes `wait_for_student` from `complete` within
the existing guide/needs-input replies. After a demonstrated step, the host sends
a bounded instruction through validated agent progress to the chat, then polls
the native companion state. Its optional `guidance` snapshot contains only the
current epoch, terminal reason and aggregate input revision, never key contents
or pointer positions. A 500ms quiet period groups a click/typing burst. Any real
input requests a fresh observation; it does not verify that the highlighted
control was used. Clicking during playback or final-answer generation follows
the same host transition. Native terminal admission and frame fencing remain
unchanged: the old epoch is released before a new one is begun.

Lessons retain their goal through local waits, questions and resource pauses.
Each SDK run has a forty-five-second deadline and eight model turns; the local
lesson has no fixed suggestion count or idle timeout. Native screen revisions
also resume it after hover or delayed loading. Admission is capped at twelve SDK
runs per minute, with a resource cooldown. Execution keeps its two-minute worker
timeout. See [TeachingObservationDesign.md](../teaching/TeachingObservationDesign.md) for
watch lifetime, history bounds and retained-answer contracts. Presentation and
transport errors are not automatically replayed.

## Esc is the lesson cancel control

`AgentChatController` temporarily registers Esc through its injected
`AgentCancelShortcut` port for a Show me request. `GlobalTaskCancelShortcut`
uses Electron’s global shortcut API so Esc can cancel while another app is in
front. It unregisters when the lesson finishes, is canceled or the controller
is disposed. If another application owns Esc, registration can fail; the
workspace Esc button and focused-window Esc handler remain available.
Late callbacks cannot cancel a newer lesson. Ordinary pointer/key/scroll input
never invokes this cancel port. The teaching model cannot call
`cancel_cursor_sequence`; native segment interruption still prompts observation.

`TeachingTaskRunner` maps native session/lease cancellation reasons to failed
lesson outcomes. Only explicit student cancellation produces canceled. Idle
waiting still asks a question. Escape cancellation also fences pending credential
loading and late successful model answers in main.
