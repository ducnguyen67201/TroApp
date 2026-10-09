# Scribble drawing replacement specification

Status: Implemented; automated validation passed. Physical and live-model acceptance pending.

Date: October 8, 2026.

This document specifies the requested replacement of Tro's teaching drawing engine.
It records the requested design and acceptance requirements.
[Architecture.md](Architecture.md) remains the maintained description of the
implemented system, and [README.md](../README.md#validation)
owns validation commands. The separate specification was requested explicitly for
this change.

## 1. Outcome and scope

Tro will have one teaching drawing engine: a scribble renderer. The model will
describe drawings as short lists of points in the same response that supplies the
instruction and student action. The native app will turn those points into smooth,
animated strokes.

The replacement removes the existing fixed drawing gestures and their old playback
implementations. It preserves the floating cursor, voice HUD, narration, student
input observation, Esc, account cleanup and normal computer-use execution feedback.

The current native `CursorCompanion` also owns session and cursor-following behavior.
Those responsibilities must move to explicit session/following owners before its
old drawing implementation can be removed. The TypeScript file
[CursorCompanion.ts](../src/contracts/CursorCompanion.ts) is a collection of shared
contracts, rather than the drawing class itself; it must not be deleted wholesale.

The intended result is one active drawing path, with no legacy fallback or permanent
setting that selects between two renderers. The implementation must preserve other
uncommitted work in the repository.

Scribbles improve which shapes Tro can draw. They do not establish that the model
selected the correct content. Coordinate conversion, drawing quality and target
selection must be assessed separately.

## 2. Previous and replacement flow

Before replacement (reference only):

```text
Current screenshot
  -> present_teaching_step: instruction + action target
  -> TeachingActionPresentation: generate fixed gesture steps
  -> native show_cursor_sequence
  -> paired drawing/HUD receipt
```

Replacement:

```text
Current screenshot
  -> present_teaching_step: instruction + action target + drawing strokes
  -> validate action and drawing
  -> native tool converts points once and compiles paths from the bound capture
  -> refresh the screen, verify its geometry and compare regions using those paths
  -> native overlay installs drawing and HUD under the current render fence
  -> paired receipt
  -> wait for student input or a bounded loading result
```

No separate model call will select, check or smooth a drawing. The existing bounded
repair behavior may still request a corrected proposal after invalid input or a
changed screen. Additional points consume response tokens, so this design does not
promise zero additional generation time.

No OCR, text-anchor lookup or text-match admission gate will be introduced.

## 3. Model-facing drawing contract

Add a focused contract in `src/contracts/TeachingDrawing.ts` and import it into
[PresentTeachingStepSchema](../src/contracts/TeachingStep.ts). Derive TypeScript
types from strict runtime schemas and declare policy limits with named constants.

The new field is required but nullable:

```json
{
  "drawing": {
    "strokes": [
      {
        "points": [
          { "x": 0.3, "y": 0.45 },
          { "x": 0.4, "y": 0.46 },
          { "x": 0.5, "y": 0.45 }
        ],
        "closed": false
      }
    ]
  }
}
```

This example describes an open stroke. A closed stroke describes a loop. Several
strokes allow disconnected marks, such as an arrow shaft and its two head segments.
All shapes use the same point-path renderer.

Initial limits:

| Value                    | Requirement                                                 |
| ------------------------ | ----------------------------------------------------------- |
| Strokes per presentation | 1–3 when drawing is present                                 |
| Points per stroke        | 2–32; no more than 96 input points in total                 |
| Coordinates              | Finite numbers in `[0, 1]`                                  |
| Open stroke              | At least two distinct points and visible length             |
| Closed stroke            | At least three distinct, noncollinear points                |
| Closure                  | Explicit `closed` value; the host closes the loop           |
| Styling and timing       | Host-owned; no model-selected colour, thickness or duration |
| Total playback           | Retain the existing bounded 15-second ceiling               |

Consecutive repeated points may be removed during compilation. A repeated first
point at the end of a closed stroke is redundant and is removed before closure.
These operations must not change which region the model selected. Reject a stroke
that has no visible length after conversion; do not invent replacement geometry.

The nullable field and action must agree:

| Student action                                   | Drawing requirement                              |
| ------------------------------------------------ | ------------------------------------------------ |
| Click, drag, scroll, highlight, unfocused typing | Non-null drawing with valid strokes              |
| Keyboard shortcut, focused typing, loading wait  | Explicit `drawing: null`; text-only presentation |

An empty stroke list cannot turn a spatial instruction into a text-only step.
Validate these rules in Tro after tool parsing as well as documenting them in the
model-visible schema. Update proposal correction feedback to explain point and
target bounds without replacing the original teaching goal.

## 4. Coordinates and smooth paths

Use the existing normalized coordinate system for both drawing points and action
target boxes. The origin is the screenshot's top-left corner; X increases rightward
and Y increases downward. The drawing is bound to the proposal's `captureId`.

Retain screenshot pixel dimensions, logical display dimensions, primary-display
scope, scale and capture ownership from the current capture. Tro currently exposes
the primary display scope, rather than a persistent unique monitor identity.
Never use the attachment's
preview size, guessed editor dimensions or an unrelated capture to convert points.

The native compiler maps each point to logical display coordinates once. The
platform adapter owns any display-origin adjustment, Y-axis conversion and backing
scale needed by its compositor. The worker must not repeat those transformations.
Out-of-range model input is rejected rather than silently moved to an edge.
Normalized boundary values must map to valid drawable display edges consistently.

Use quadratic smoothing inspired by OpenClicky's
[smooth scribble renderer](https://github.com/jasonkneen/openclicky/blob/e9eb06a29ff5cd82033d032238f51a936168b05a/cursor-buddy/OverlayWindow.swift#L1700-L1851):

- Two points produce a straight segment.
- Longer open paths use neighboring midpoints and quadratic curves. Preserve the
  first and last point.
- Closed paths use cyclic neighbors and close continuously, without an open seam.
- Intermediate input points guide the curve; the curve need not pass through each
  one. Smoothing must remain within the input points' envelope.

Compile a bounded representation of the curve from the bound capture before the
regional comparison. Refresh must confirm unchanged display geometry before that
same compiled path can be painted. Do not compile a different path after admission
or rebuild it every frame. Reveal by distance along that same path so uneven point
spacing does not produce uneven pen speed. Use round stroke caps and joins. The
same compiled geometry must supply rendering, freshness coverage and diagnostic
bounds. Account for half the stroke width when computing visible bounds.

Keep reveal, hold and clear timing in one host policy. Reduced-motion presentation
shows the completed stroke without the progressive animation. A reduced-motion
presentation still needs a real drawing receipt.

## 5. Action targets and admission

The student action and the drawing have different jobs:

- Action target boxes define the expected student click or drag endpoints.
- Drawing strokes explain that action visually.

Replace `TeachingActionPresentation.ts`
with a focused action-target helper, such as `TeachingActionTargets.ts`. Keep its
mapping from typed actions to target boxes and `TeachingInteraction`. Remove its
shape generation. Never derive a click target from a stroke's bounding box or treat
the pen's movement as student input.

Keep existing lesson, goal revision, capture, input revision, permission and
session checks. Host-generated task epochs and presentation IDs remain unavailable
to model override.

The native refresh must support both action target regions and relevant stroke
regions. Today, a supplied target list replaces the old cue comparison regions;
the replacement must deliberately address this behavior. Compare the actual
stroke-covered area with bounded surrounding context, together with action targets.
Avoid using one large rectangle around a long path that would unnecessarily include
unrelated animation. Do not broaden existing pixel-change tolerances merely to make
the new engine pass.

Local checks establish valid geometry, current screen regions and successful
presentation. They cannot prove that a mark identifies the correct control or
content. Do not add an unvalidated semantic-target heuristic as part of this change.

## 6. Native rendering, receipts and control recovery

Implement `ScribbleRenderer` through the existing native Cua overlay and compositor
in [CursorCompanion.patch](../driver-patches/CursorCompanion.patch). No second Swift
overlay, Electron drawing window or independent receipt owner is required.

Keep the current immutable presentation identity and synchronous native
installation fence. One presentation owns its message and all requested strokes.
Success requires a correlated message/drawing receipt for that presentation. A
pointer-only frame, empty stroke, final clear frame or process exit does not count
as a drawing receipt.

For an uninterrupted presentation, complete the receipt only after every requested
stroke has been fully revealed and its minimum host-defined visible hold has been
observed by the compositor. Clearing is cleanup and is not presentation evidence.
The receipt includes a bounded `strokes_presented` list with `stroke_index`,
`trace_progress` and `hold_ms_observed`. Indices must be unique, in range and cover
all requested strokes for an uninterrupted successful result. Progress is within
`[0, 1]`; completed strokes have progress 1 and meet the required hold. The worker
validates this evidence as well as the existing message/drawing flags.

Retain the distinction between completed and interrupted presentations. Record
which strokes actually appeared and their painted progress. Interruption must not
claim that every requested stroke was shown. A delayed receipt from a canceled or
superseded presentation cannot commit a checkpoint or restart narration.
An interrupted spatial receipt is valid only if the correlated message and a
nonempty visible stroke were installed; interruption before any drawing appeared
returns a refusal/cancellation rather than a successful drawing receipt.

Retain these control behaviors:

- Student click, key or scroll interrupts the drawing and returns the lesson to
  observation under the existing teaching rules.
- Esc cancels the lesson, clears current marks and fences later callbacks.
- A rendering or transport failure settles the operation, releases drawing
  ownership and leaves voice input and Esc usable.
- A later explicit retry or newly admitted request can work without pressing Esc
  to unlock a stuck state.
- Account switch, sign-out, sleep, window teardown and lost session/lease invalidate
  pending work and clear the correct owner's presentation.

Do not replace the normal native executor's cursor feedback, the HUD state machine
or the narration provider as part of this drawing replacement.

## 7. One protocol and cutover

Introduce drawing presentation version **3**. The version is selected and enforced
by trusted host configuration, rather than supplied by the model.

The proposed private native presentation tool is `present_teaching_guidance`. It
carries the bound capture, presentation identity, validated drawing, action-derived
targets and the existing HUD message/locale binding. Explicit text-only proposals
carry a null drawing. The tool remains inaccessible to direct model dispatch;
`present_teaching_step` is the model's entry point.

The new tool owns path compilation, local capture refresh, regional comparison and
presentation within one native request. This lets it reuse the exact compiled
geometry through checking and painting. Move existing freshness checks into that
request without weakening them. `LoggedCuaServer` must not also invoke the old
pre-presentation refresh route for the new tool. Preserve ordinary observation
tools and their separate uses.

Keep the requested capture ID and refreshed capture ID distinguishable in native
diagnostics. Refreshed display geometry must match the bound capture, and existing
input/session fences must still be checked before frame installation.

Update canonical native request/result schemas, capability replies,
begin-task version checks and the TypeScript boundary validators together.
Capabilities advertise version 3 and the scribble limits. Receipts and coordinate
traces identify strokes instead of old fixed drawing gestures.

Retain compatible session/following/HUD lifecycle tools where they still serve
their existing purpose. Remove old V1/V2 teaching drawing dispatch and omitted-version
fallbacks after all callers move. Do not reinterpret an old drawing request as a
new one.

Bump [CuaCompanionBuild.ts](../src/contracts/CuaCompanionBuild.ts), rebuild the
executable, refresh build provenance and package the matching driver. Startup must
refuse an old or incompatible driver before drawing. Restart the desktop after the
rebuild so the running daemon uses the new executable.

The final source and packaged application must have one teaching drawing engine.
Reverting the change uses a previous complete app/driver build; it does not require
shipping two engines or keeping a permanent compatibility flag.

## 8. Implementation sequence

Complete all related implementation, fixtures and documentation edits before
running final validation.

| Step                      | Work                                                                                                                   | Completion condition                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1. Contracts              | Add `TeachingDrawing.ts`; extend the presentation schema; define stroke limits and text-only agreement                 | Strict schemas describe the complete model proposal                                    |
| 2. Agent instructions     | Update `CreateComputerUseAgent.ts`, `ComputerUseInstructions.ts` and `TeachingProposalRecovery.ts`                     | One presentation call supplies action, instruction and strokes; guidance stays general |
| 3. Worker presentation    | Replace shape generation with action-target extraction; update `TeachingPresenter.ts` and `LoggedCuaServer.ts`         | Exact validated strokes reach the native request; targets remain independent           |
| 4. Native engine          | Implement smoothing, bounded compilation, local refresh/comparison and progressive rendering within one native request | Rendering and checks reuse the same converted geometry                                 |
| 5. Ownership and protocol | Move session/following responsibilities out of the old drawing class; enforce version 3 and paired receipts            | Old drawing handlers are unreachable and removed                                       |
| 6. Build and cleanup      | Update capability schemas, build pin, native tests, packaging, fixtures and previews                                   | New app/driver pairing is required; obsolete playback code is gone                     |
| 7. Documentation          | Update implemented ownership in `Architecture.md` and commands/check instructions in README                            | Runtime docs reflect actual completed code rather than this proposal                   |
| 8. Final validation       | Run repository, worker, teaching and native checks; perform physical smoke tests                                       | Acceptance results and any remaining limitations are recorded                          |

Key existing entry points:

- [TeachingPresenter.ts](../src/desktop/worker/teaching/TeachingPresenter.ts)
- [LoggedCuaServer.ts](../src/desktop/worker/cua/LoggedCuaServer.ts)
- [CuaCompanionClient.ts](../src/desktop/worker/cua/CuaCompanionClient.ts)
- [CreateComputerUseAgent.ts](../src/desktop/worker/agent/CreateComputerUseAgent.ts)
- [ComputerUseInstructions.ts](../src/desktop/worker/agent/ComputerUseInstructions.ts)
- [TeachingProposalRecovery.ts](../src/desktop/worker/teaching/TeachingProposalRecovery.ts)
- [BuildCuaCompanion.ts](../scripts/BuildCuaCompanion.ts)

## 9. Cleanup inventory

Remove or replace:

- `TeachingActionPresentation`, `createTeachingActionPresentation`, `selection`
  and drawing-only `center`/geometry helpers.
- The native fixed drawing variants: circle, arrow, move, drag, selection and click.
  Student click/drag actions remain in the teaching action contract.
- Shape-specific `plan_path`/`plan_mark` branches and obsolete sampling code.
- Legacy drawing `show_sequence`/`play_sequence`, V1-only frame receipts and mark
  commands, once their remaining callers have been moved or removed.
- Old `show_cursor_sequence` drawing discovery, dispatch and adapters; replace
  paired presentation use with the version-3 tool.
- Old drawing version defaults, gesture capability entries and fallback routes.
- Drawing-only tests and fixtures that assert the removed gesture protocol;
  replace them with stroke tests rather than deleting lifecycle coverage.
- Obsolete generated drawing schemas/resources from the build/package output.

Keep or refactor without dropping behavior:

- `DesktopCompanion`, its authenticated startup and `UseCursorCompanion`.
- Cursor following, task ownership, leases, cancellation and state contracts.
- `CompanionHudController`, `CompanionHudClient`, `CompanionHudPublisher` and the
  separate HUD worker.
- Capture metadata, overlay exclusion, student observation and input matching.
- Native render fences, narration staging/revocation and account cleanup.
- Normal native executor feedback, permissions and unrelated app features.

Keep native scribble regressions in the build's `companion` Cargo selection;
merely naming them `scribble` would silently exclude them. Also run the focused
MCP proxy/envelope suites so cancellation, queued actions, protocol handling and
EOF cleanup remain covered after changing control dispatch. Run the core session
suite when changing transport-owner admission or retirement.

Search both owned source and built/package output to confirm that removed drawing
symbols and handlers no longer remain. Do not delete user data, configuration,
unrelated caches or other developers' changes as cleanup.

## 10. Diagnostics and latency

Extend the existing event-driven coordinate diagnostics. Keep the same lesson,
step, capture and presentation IDs across proposal, local checking and native
installation. Record bounded stroke/point counts, capture/display dimensions,
planned and painted bounds, actual reveal progress and explicit rejection reasons.

Measure these stages separately:

1. Model response generation.
2. Proposal validation.
3. Screen refresh and regional comparison.
4. Coordinate conversion and path compilation.
5. First installed visible drawing frame and presentation completion.

Use the development exchange logger for permitted content traces. Ordinary logs
must not contain screenshots, raw pixels, instruction text, target labels, typed
content, credentials or hidden reasoning. Do not log each animation frame or
routine observer poll.

Report model latency and local rendering latency separately. Compare local timings
against the current path using reproducible fixtures and the same device. Point
limits and animation policy must prevent unbounded work. Keep normal presentation
free of a second inference round trip.

## 11. Verification and acceptance

Use the required commands in [README.md](../README.md#validation). This change
affects runtime wiring and native rendering, so final validation includes the
standard lint, formatting, type, unit, build and integration checks, the worker
bundle check, teaching flow checks, native driver build and native teaching checks.
Fixtures must run without private credentials or a paid model call.

Automated acceptance:

| Area               | Required evidence                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input validation   | Invalid, oversized, nonfinite, empty and duplicate-only paths are rejected; valid boundaries and loops work                                                                                                    |
| Presentation rules | Spatial actions require strokes; text-only actions require null; no empty-list bypass exists                                                                                                                   |
| Geometry           | Two-point lines, open curves and closed loops render consistently; smoothing stays bounded; converted and painted bounds agree                                                                                 |
| Display mapping    | Known points map correctly for multiple screenshot sizes and backing scales; changed display geometry refuses presentation                                                                                     |
| Freshness          | Target and relevant stroke changes are detected; unrelated distant animation does not block the drawing                                                                                                        |
| Student matching   | Click/drag matching uses the action's target boxes even when decorative stroke bounds differ                                                                                                                   |
| Receipts           | Every requested stroke needs reveal/hold evidence for uninterrupted success; missing, foreign, stale, pointer-only and clear-only receipts cannot commit a spatial step; interrupted progress is truthful      |
| Controls           | Esc fences queued frames; a failed request does not block the next voice hold; teardown cannot revive old marks; ordinary calls retain arrival order and closed transports cannot admit delayed first requests |
| Cutover            | Old driver/new app combinations fail explicitly; no old drawing renderer or compatibility route remains                                                                                                        |
| Diagnostics        | Events correlate all stages and exclude prohibited content; new native tests are actually selected by the build                                                                                                |

Physical acceptance on the supported macOS primary display:

- Draw known marks near the top, centre, edges and bottom of the screen at available
  display scales. Compare the intended location with the visible stroke and trace.
- Exercise underlines, open curves, closed outlines, disconnected strokes and
  two-endpoint drag guidance in several applications.
- Interrupt during drawing, cancel while frames are queued, switch accounts, and
  verify marks clear without late reappearance.
- Hold voice after a successful first turn and after a failed drawing request;
  confirm no Escape step is needed to restore admission.
- Evaluate live model target selection separately from conversion accuracy and
  drawing appearance. Synthetic receipts do not establish physical scan-out or
  model quality.

Implementation is complete only when the new renderer is the sole teaching drawing
path, obsolete playback is removed, required checks pass and physical results are
reported honestly. Unavailable hardware or live-model checks remain explicit limits;
they cannot be represented as passing tests.
