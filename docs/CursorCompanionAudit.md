# Cursor companion architecture audit

October 1, 2026. Scope: the proposed
[guidance spec](CursorCompanionGuidanceSpec.md), evaluated against current worker,
MCP wrapper and native patch integration. V2 has not been implemented. This is
a design audit, not a live model evaluation or production release certification.
The original spec and application code were left unchanged.

## Severity-ranked findings

### A1 — High: Teaching success does not require a completed demonstration

**Symptom:** the task can finish as completed without showing a guide, or after
a failed guide followed by unrelated desktop verification.

**Mechanism:** `CuaTaskEvidence.reset()` starts with no issue and does not record
a requirement for positive preview evidence. `ComputerUseTaskRunner` accepts
that absence of issues as completion. `verify_state` with `satisfied` also clears
the single issue field, including `GUIDANCE_FAILED`. The spec's native receipt
guarantee does not define an independent task-level teaching completion gate.

**Layers:** 6 tool selection, 7 execution, 8 interpretation. **Confidence:** 1.00.

**Evidence:** [spec completion](CursorCompanionGuidanceSpec.md:309),
[evidence reset](../src/desktop/worker/CuaTaskEvidence.ts:39),
[verification overwrite](../src/desktop/worker/CuaTaskEvidence.ts:86),
[task completion](../src/desktop/worker/ComputerUseTaskRunner.ts:118).

A local, credential-free probe of the real evidence class returned:

```json
{"case":"no_preview","issue":null}
{"case":"preview_failed","issue":"guidance_failed"}
{"case":"unrelated_verification","issue":null}
```

**Fix:** define typed task outcomes for demonstration-required versus
explanation-only answers. A required demonstration needs positive, validated
native completion associated with the current task. Keep guidance evidence and
desktop-action verification separate; satisfying one cannot clear the other.
An explanation, limitation or clarification must not count as a demonstrated
lesson. This evidence gate confirms presentation, not semantic correctness of
model-selected targets or student success.

**Acceptance:** no-tool and observation-only runs cannot report a demonstrated
task. Failed preview plus satisfied verification stays incomplete. A valid
preview receipt satisfies only that task's guidance requirement.

### A2 — High: Student takeover can trigger another guide through recovery

**Symptom:** the student clicks to take over, the guide stops, then a new guide
starts without a new student request.

**Mechanism:** the proposed cancellation contract terminates one native
sequence. A tool error is returned to the still-running model, which can call
another sequence immediately. If `GUIDANCE_FAILED` survives the first model
run, the current task runner automatically starts one further five-turn
continuation using an execution-oriented recovery prompt. Debug logging exposes
that continuation to developers, but it is not a user-visible retry contract.

**Layers:** 8 interpretation, 11 hidden repair loops. **Confidence:** 0.99.

**Evidence:** [takeover contract](CursorCompanionGuidanceSpec.md:282),
[Stop path](CursorCompanionGuidanceSpec.md:301),
[generic recovery prompt](../src/desktop/worker/ComputerUseTaskRunner.ts:27),
[automatic continuation](../src/desktop/worker/ComputerUseTaskRunner.ts:119).

**Fix:** distinguish `completed`, `canceled` and `failed` internally with typed
reasons, even if successful public receipts retain their existing shape. On
takeover, latch the task epoch as canceled, prevent further presentation
admission for that task, and terminate its model run or return a typed canceled
outcome. Do not apply the generic repair continuation. Explicit Stop already
closes transport; extend the task-level terminal policy to native takeover.
Replay requires a new user instruction. If automatic recovery remains for
other failures, give it an explicit bounded policy and observable reason.

**Acceptance:** after cancellation in any phase, simulated further model tool
calls are refused for that task. Assert there is no second model run, no late
completed result and no new guide. A new user task can demonstrate again.

### A3 — High: Omitting V2 selects legacy behavior

**Symptom:** a new teaching task unexpectedly cancels when the student moves
their cursor, or uses the old timing even with the new driver installed.

**Mechanism:** the proposed request makes V2 explicit but leaves omitted version
as V1. Capabilities prove that V2 is available, not that an invocation selected
it. Prompting the model to send V2 is insufficient to make the cancellation
policy host-owned. The existing SDK schema conversion is non-strict and the
spec does not identify a dispatch check that pins the negotiated version.

**Layers:** 6 selection, 7 execution. **Confidence:** 0.98. This is a proposed
contract gap, not a claim that native V2 currently exists.

**Evidence:** [legacy default](CursorCompanionGuidanceSpec.md:137),
[capability admission](CursorCompanionGuidanceSpec.md:186),
[host-owned policy](CursorCompanionGuidanceSpec.md:194),
[V2 movement rule](CursorCompanionGuidanceSpec.md:295),
[SDK configuration](../src/desktop/worker/CreateComputerUseAgent.ts:21).

**Fix:** bind presentation version to trusted task configuration. The teaching
tool schema should require V2, and the adapter must enforce that same version
before native dispatch. Alternatively, the trusted adapter injects the
negotiated version and rejects incompatible caller values. Keep V1 available
only to explicit legacy clients; model omission cannot select it for new tasks.

**Acceptance:** omitted, mismatched and unknown versions cannot select V1 in a
V2-required task. An older driver fails before starting a guide. An explicitly
legacy client still follows the documented V1 compatibility path.

### A4 — Medium: Final acknowledgement can hide skipped cues

**Symptom:** under a scheduler/render stall the companion jumps to its return
position, and the tool reports success even though a gesture or its hold was
never presented.

**Mechanism:** the spec samples current elapsed time and coalesces to one latest
frame. Those choices can discard an entire trace and hold interval. The only
required receipt is for the terminal clear/return frame. The accepted cleanup
test for skipping a phase boundary does not establish that each cue displayed.

**Layers:** 10 rendering, 8 interpretation. **Confidence:** 0.95. This is a
design-path risk; no native V2 stall was reproduced.

**Evidence:** [elapsed-time sampling](CursorCompanionGuidanceSpec.md:200),
[coalescing](CursorCompanionGuidanceSpec.md:239),
[terminal receipt](CursorCompanionGuidanceSpec.md:309),
[skipped-frame test](CursorCompanionGuidanceSpec.md:353).

**Fix:** require step-tagged render evidence for each completed cue and a
compositor-observed hold interval. Define an allowed stall gap for progressive
tracing. If the promised presentation cannot be delivered within the existing
watchdog, clear and fail; do not catch up by silently skipping the lesson or
stretch it indefinitely. Intermediate frames may still be coalesced.

**Acceptance:** a stalled renderer that acknowledges only the final frame cannot
complete. Missing cue receipts or insufficient observed holds fail. Normal
coalescing preserves ordering, the time budget and one active cue.

## Architecture diagnosis

The deepest gaps lie between the native sequence and the agent task. The spec
defines a strong presentation controller, but relies on existing wrappers whose
success, recovery and version contracts do not yet enforce the reviewed lesson.
Adding more prompt instructions would leave those paths open.

The earlier metadata incident remains relevant: the SDK's content-only path
needed Cua structured targeting metadata appended alongside screenshots. The
current wrapper preserves both, with regression coverage in
[LoggedCuaServer.test.ts](../src/desktop/worker/LoggedCuaServer.test.ts:7).
Do not remove that adapter while refactoring the protocol. That historical
transport failure is not a new unresolved finding in this audit.

| Layer                  | Audit result                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 System prompt        | Teaching appends to the execution-oriented base prompt. Code denies forbidden input tools, so this is residual prompt conflict rather than evidence of unauthorized execution. Separate mode instructions when revising recovery. |
| 2 Session history      | Initial runs receive the current message. The bounded recovery reuses same-task history; no cross-task history injection was found in the inspected path.                                                                         |
| 3 Long-term memory     | No memory store/admission path found in the scoped worker.                                                                                                                                                                        |
| 4 Distillation         | No compression or distilled artifact reinjection found.                                                                                                                                                                           |
| 5 Active recall        | No retrieval/recall layer found.                                                                                                                                                                                                  |
| 6 Tool selection       | Allowlist enforces forbidden tools, but required preview and V2 selection need code gates: A1/A3.                                                                                                                                 |
| 7 Tool execution       | Native validates session/capture/geometry; task success does not require positive preview evidence: A1.                                                                                                                           |
| 8 Tool interpretation  | Generic verification can erase guidance failure, and takeover is not task-terminal: A1/A2.                                                                                                                                        |
| 9 Answer shaping       | Final prose is passed through; the typed task envelope can still incorrectly label it completed: A1.                                                                                                                              |
| 10 Platform rendering  | Atomic frames and generation fencing are specified; per-cue rendered-time guarantees are missing: A4.                                                                                                                             |
| 11 Hidden repair loops | One extra SDK run is code-visible and debug-logged, but lacks takeover-aware retry semantics: A2.                                                                                                                                 |
| 12 Persistence         | Capture freshness and generation fencing are explicit. Semantic layout tracking is expressly deferred; no new memory persistence was proposed.                                                                                    |

The configured model is `gpt-5.4` through the authenticated Tro gateway. Entry
points are typed/spoken teaching tasks and the host Stop/follow lifecycle. The
inspection did not invoke a model, send screenshots, change native permissions,
or reproduce production timing. No current V2 runtime or cross-session memory
contamination is claimed.

## Ordered fix plan

1. **Task evidence:** require a task-bound positive guide receipt and independent
   action verification. Define explanation/clarification outcomes.
2. **Cancellation and recovery:** make takeover task-terminal, latch its epoch,
   block automatic replay, and classify any permitted retries explicitly.
3. **Protocol selection:** pin the negotiated presentation version in trusted
   dispatch, backed by the tool schema and compatibility tests.
4. **Presentation evidence:** define per-cue receipts, observed hold time and
   bounded stall failure. Add fake-clock/fake-renderer tests for whole-phase loss.

Amend the spec with these contracts before implementing the native timeline.
CUA ownership, pure planning and the native renderer boundary can remain.

## Verification and report

A credential-free probe of the current evidence class confirmed A1's two
paths. A2's continuation and A3/A4's specification gaps were established by
source inspection; they were not live-tested. No application code or original
specification was modified. Formatting and repository boundary checks are the
appropriate validation for these report artifacts.

Machine-readable report:
[CursorCompanionAudit.json](CursorCompanionAudit.json), using
`ecc.agent-architecture-audit.report.v1`.
