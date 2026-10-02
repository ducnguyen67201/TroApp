# Cursor companion engineering

The native V2 implementation follows the reviewed
[guidance specification](CursorCompanionGuidanceSpec.md). Tro ships the pinned
Cua source plus `driver-patches/CursorCompanion.patch`; no sibling source or
Electron presentation window is used. The local build version is `0.30.4-tro.2`.

## Ownership

`ComputerUseTaskRunner` admits a fresh host-generated task epoch before running
the Agents SDK. `LoggedCuaServer` filters the teaching catalog, requires literal
`presentation_version: 2`, rejects identity overrides and concurrent calls during
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

Passive real mouse movement is allowed while watching. Clicking, typing or
scrolling latches `user_takeover` for the whole teaching task. Explicit Stop,
session loss and lease expiry also invalidate playback. Renewing the following
lease cannot revive a canceled task. A new host task epoch is required.

Tro independently tracks guidance receipts and desktop-action verification. A
native receipt must match the current task, dispatched step count, V2 version
and an unused sequence identity. Model prose, observation, or `verify_state`
cannot create guidance evidence or clear a guidance failure. The SDK receives
both screenshots and Cua structured metadata; neither is logged in ordinary logs.

The public bridge carries `kind: teaching` with a typed outcome. `demonstrated`
requires positive receipts and successful host release; `needs_input` means no
demonstration completed. Canceled/failed results carry a reason and display
deterministic English/Vietnamese copy rather than a model completion claim.
Typed and voice replies share this rendering path. `explained` remains reserved
for a future explicit host-authorized explanation mode; ordinary Show me cannot
silently choose it.

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
