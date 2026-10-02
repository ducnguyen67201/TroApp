# Agent-requested task verification

Status: implemented in the local worker on October 1, 2026. Live-model and multi-monitor judgment quality still require platform evaluation. [AgentHarnessSpec.md](AgentHarnessSpec.md) contains the complete architecture, limits and audit regression requirements.

## One request

1. ComputerUseTaskRunner creates a fresh TaskContext, TaskHarness, MainAgentRunner and TaskVerifier using the original instruction and existing app locale.
2. The main agent calls define_task_goal with faithful natural-language criteria. The worker assigns IDs and freezes the goal. Writes require acknowledgement in a later model turn.
3. Desktop calls collect actual text, images and facts. They do not judge task completion.
4. When the main agent believes the result is ready, it calls verify_task.
5. The harness synchronously enters verifying, blocks writes, settles queued calls and builds an evidence packet. The main agent waits.
6. The read-only SDK verifier receives the original request, immutable criteria, locale and current evidence from both agents. Actor claims, reasoning and previous verdicts are excluded.
7. It interprets whether the request is fulfilled, optionally obtaining a small targeted read. It cannot repair the desktop.
8. CompletionGate validates the judgment's consistency, coverage, real evidence and freshness. The harness stores a task-bound verdict ID.
9. The main agent repairs missing work within the remaining budgets or returns a final proposal with the stored ID.
10. The final gate rechecks cited observations after the main agent's answer turn, then the harness settles the public result and discards task-local evidence.

Verification is sequential and explicitly requested. No observer runs in parallel, after each action or on a timer. One optional main-agent continuation can request missing work or fresh verification; it does not start verification itself.

Tool-free conversation can settle as response mode. Any desktop tool use, including read-only discovery and failed calls, makes that bypass unavailable. If the main agent never defines a goal, the attempt ends with a localized failed result.

## Review files in this order

| File                                         | Responsibility                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| src/desktop/worker/TaskHarness.ts            | Coordinates one task, explicit verification, continuation and settlement  |
| src/desktop/worker/TaskExecutionPorts.ts     | Narrow task-bound main-agent, verifier and model-tool controls            |
| src/desktop/worker/TaskContext.ts            | Phases, task identity, immutable request/goal, cancellation and budgets   |
| src/desktop/worker/CreateComputerUseAgent.ts | SDK construction; tools delegate to harness controls                      |
| src/desktop/worker/MainAgentRunner.ts        | Main SDK execution and private continuation history                       |
| src/desktop/worker/TaskVerifier.ts           | Read-only SDK agent receiving the evidence packet                         |
| src/desktop/worker/TaskVerification.ts       | Canonical decision, structured verdict and assessment types               |
| src/desktop/worker/CompletionGate.ts         | Consistency, provenance, capture freshness and final-ID checks            |
| src/desktop/worker/TaskEvidencePacket.ts     | Validated packet with deduplicated content and encoded-size limits        |
| src/desktop/worker/CuaTaskEvidence.ts        | Bounded raw evidence, revisions, capture ordering and supersession        |
| src/desktop/worker/CuaObservation.ts         | Conservative target, fact and observation-category extraction             |
| src/desktop/worker/LoggedCuaServer.ts        | Serialized dispatch, desktop-use flag, write admission and capture        |
| src/desktop/worker/ReadOnlyCuaServer.ts      | Read-only catalog and runtime capability enforcement                      |
| src/desktop/worker/ComputerUseTaskRunner.ts  | Reusable Cua connection lifecycle and per-request composition             |
| src/desktop/worker/TaskResult.ts             | Public outcomes and localized uncertain-result fallback                   |
| src/desktop/worker/AgentDebugLog.ts          | Always-on serialized-request guard and optional redacted metadata logging |

## Contracts and judgment

The main agent defines a summary and one to five natural-language criteria. There are no fixed task categories, expected-URL predicates or website-specific completion rules.

The verifier returns:

```ts
{
  decision: 'confirmed' | 'needs_work' | 'blocked' | 'unknown',
  summary: string,
  missingRequirements: string[],
  criteria: Array<{
    criterionId: string,
    state: 'satisfied' | 'unsatisfied' | 'unknown',
    evidenceIds: string[],
    explanation: string
  }>
}
```

The original request remains authoritative. Missing original requirements prevent success even when every listed goal criterion passes. Confirmed requires complete goal coverage, all satisfied criteria with usable evidence, and no missing requirements. Needs-work requires an unsatisfied criterion or missing requirement. Blocked requires an unmet result and an explanation of the observed obstacle. Unknown requires an unknown criterion or unresolved original requirement.

Independent requestSatisfied/blocked flags and their contradictory combinations are removed. Invalid decisions, IDs, coverage or stale evidence become unverified feedback.

The main agent's proposal remains `{ mode, answer, verificationId }`. The code gate performs no LLM call and does not interpret arbitrary application intent. The verifier model performs semantic judgment; code checks that its judgment is consistent and cites real admissible observations. Provenance does not guarantee correct visual interpretation.

## Evidence policy

Actual Cua text, images and structured content are retained in task-local memory before returning results to either agent. Shared content hashes deduplicate images. Verifier-only observations remain available for a second attempt even though the first nested SDK history is gone. MainAgentRunner alone owns actor history for continuation.

Failed/refused/malformed results cannot establish success. Observation facts use supported driver fields; identities are never merged by PID alone. Content and visibility are separate categories. Raw structured content remains available to the model to assess details such as monitor bounds.

Every mutation, including a failed one, advances the revision. Newer captures supersede older captures for the same target/category. Latest explicit facts override older records across categories. A newer hidden-window observation invalidates an older visible observation even without a mutation.

Captures expire after 10 seconds. Verdicts record task ID, revision, evidence version, capture IDs and verification time. Final output rechecks cited captures because the answer model call can take time. Expired/superseded success asks the main agent for another explicit verification within the existing continuation budget; no automatic verifier launches.

User/app changes between captures remain possible. Results confirm observation-time state; there is no atomic live-desktop guarantee. Screenshot/text content is untrusted data, not authority to change the task or permissions. Captured content is never written to logs, disk, a database or long-term memory.

## Outcomes and limits

Public result contracts are unchanged: succeeded, partial, blocked and unverified, with criterion counts and a nullable limitation. All listed criteria passing with incomplete original scope remains unverified. Non-success replies use the verifier's localized limitation or the existing locale-specific fallback, never an unsupported actor “Done.”

Cancellation returns stopped and prevents late success. Terminal phases reject additional model/tool work. One task cannot overlap another on the reusable Cua connection.

Defaults in TaskCompletionConfig:

| Limit                                            | Default           |
| ------------------------------------------------ | ----------------- |
| Initial main-agent turns / optional continuation | 15 / 5            |
| Verification attempts / turns per attempt        | 2 / 3             |
| Shared tool calls                                | 40                |
| Worker deadline / main backstop                  | 110 / 120 seconds |
| Evidence reuse age                               | 10 seconds        |
| Encoded evidence packet                          | 4 MiB             |
| Retained raw evidence and metadata               | 16 MiB            |
| Fully serialized model request                   | 8 MiB             |

The existing repeated-inspection/no-progress execution limits remain termination safeguards, not task-success predicates. All counters survive continuation.

Obsolete evidence is discarded first when necessary; current evidence and valid actor tool-call/result history are not silently truncated. Oversized context ends as unverified when a goal exists, otherwise failed. The shared OpenAI transport checks actual request bytes with debug logging disabled and automatic retries disabled. SDK-wrapped size failures retain their typed termination reason.

The harness adds no orchestration model call. The explicitly requested verifier still costs model/image tokens. Packets avoid sending full actor history, but savings and default limits require measurement with representative displays and provider latency.

## Diagnostic logs

The existing development debug logger emits structured JSON in the desktop console during `pnpm dev`; no new environment variable or setting is required. Logging adds no model calls. Production logging remains disabled by the existing app-environment policy.

Follow one `taskId` through the following events:

| Event                                                | Diagnostic purpose                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `agent.task.started`                                 | Locale and configured limits                                                                                |
| `agent.goal.defined`                                 | Criterion count and goal acknowledgement state                                                              |
| `agent.run.started/finished/failed`                  | Main/verifier role, attempt, turn allowance, parsed proposal shape and elapsed time                         |
| `agent.model.admitted`                               | Per-attempt model turns and task-wide counters                                                              |
| `openai.request/response/failed`                     | Paired model-call ID, bytes, text/image counts, token usage, HTTP status and duration                       |
| `openai.request.rejected`                            | Serialized context budget exceeded before network dispatch                                                  |
| `cua.admission.rejected`                             | Goal acknowledgement, read-only verification, cancellation or budget rejection before driver dispatch       |
| `cua.request/response/failed`                        | Paired dispatch/call IDs, queue wait, mutation flag, safe numeric target identifiers and driver diagnostics |
| `agent.verification.started/context/finished/failed` | Verdict ID, packet sizes, observation ages/counts, supported criteria and gate reason                       |
| `agent.completion.checked`                           | Whether final proposal matches current verdict and admissible captures                                      |
| `agent.continuation.started/skipped`                 | Whether recovery runs and its allowance or skip reason                                                      |
| `agent.task.interrupted/settled/finished`            | Outcome, termination, counters and remaining budgets                                                        |

Async-local context identifies the main agent versus a nested verifier without mixing simultaneous runs. Cua refusals expose only recognized pinned-driver machine codes from structured fields or bounded text results; unknown/free-form messages are marked unavailable. Delivery hints accept only background/foreground, and target values accept numeric PID/window/display IDs. Logs also report goal acknowledgement, repeated inspections and no-progress counts. Model-input counts include tool-result output, and the tool catalog is printed only when it changes.

Never log user instructions, natural-language goals, answers, criterion explanations, transcripts, URLs, window titles, raw page/tool text, image data, credentials, HTTP headers or raw errors. These diagnostics do not alter verification, execution limits or SDK continuation behavior. In particular, an SDK initial-turn-limit exception currently stops the task before its reserved recovery attempt; the logs explicitly expose this path and its unused budget.

## OpenAI mechanism and validation

Tro's nested SDK run follows [TypeScript agents as tools](https://openai.github.io/openai-agents-js/guides/tools/), wrapped in application-owned lifecycle controls. [Codex Goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) describes a product harness; it is not a documented SDK goal-lifecycle API and does not establish Codex's internal verifier design.

Regression tests cover read-only response bypass, contradictory decisions, original-scope omissions, same-revision supersession, capture expiry during verification/answer generation, verifier-only content reuse, deduplication, byte limits, sequential callback reentry, cancellation, admission and terminal cleanup. Synthetic SDK integration exercises the actual nested run with fake model and MCP ports and validates public typed/voice schemas. No paid calls or real GUI mutations are involved.

Final checks use Node 24: pnpm lint, format:check, typecheck, test, build, test:integration and test:worker. Before release, test live macOS/Windows behavior across displays, tabs, Spaces, focus errors, permissions and cancellation. Synthetic tests cannot establish live visual accuracy.

## Embedded Cua and companion integration

`ComputerUseTaskRunner` keeps one main-owned `DesktopDriverConnection`. Its execution path constructs `TaskContext`, `TaskHarness`, `MainAgentRunner` and `TaskVerifier`; its teaching path uses `createTeachingAgent` and validates native V2 presentation receipts. Teaching does not define execution criteria, invoke `verify_task`, or enter execution recovery. Switching modes clears task-local evidence without replacing the shared daemon or the HUD transport.

`LoggedCuaServer` enforces mode and private-host-tool restrictions before dispatch. Execution calls retain serialized admission, goal acknowledgement, shared budgets and observation references. Teaching retains native capture validation, terminal takeover and no replay. Both paths emit progress through the existing worker contract; verifier model requests report thinking and targeted reads report working. Driver structured metadata remains visible to the SDK alongside screenshots; logs contain only bounded diagnostics.

Host following, cursor binding and guidance lifecycle calls bypass model discovery and task evidence. Execution pauses pointer following, then cancels presentation and restores following after settlement. Main owns daemon shutdown. The HUD shows done only for response mode, verified execution success, or successful teaching; blocked execution uses needs-input, and partial/unverified execution uses the existing error phase. Full outcome details remain in chat.

The model gateway keeps safe request/provider diagnostics and a single bounded socket retry. Integration preserves the upstream removal of the daily model request quota; transcription audio limits are unchanged.
