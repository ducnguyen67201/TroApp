# Goal orchestration harness

Status: implemented in the local worker on October 1, 2026 after the architecture audit. Live judgment quality, multi-display behavior and evidence defaults still require platform evaluation. [TaskCompletionSpec.md](TaskCompletionSpec.md) explains the worker mechanism.

## Product behavior

Tro accepts a typed or transcribed instruction and works toward the requested result until it is verified, blocked, cancelled, or stopped by an execution limit.

The main agent chooses actions and decides when to request verification. A worker-owned orchestration harness controls task state, tool admission, verification execution, continuation and the final public result. The harness is ordinary TypeScript control code; it adds no orchestration LLM.

Verification remains explicit and sequential. It runs only when the main agent calls `verify_task`. Ordinary desktop tool calls collect observations and enforce limits without judging completion.

For “open YouTube,” the intended sequence is:

1. The harness creates a task from the original instruction and current locale.
2. The main agent defines the required result, then locates or opens the appropriate window.
3. The main agent calls `verify_task` when it believes the result is ready.
4. The harness pauses further desktop mutations and invokes the read-only verification agent.
5. The verifier checks the request against actual observations, obtaining a targeted read if needed.
6. The harness validates and stores the verdict.
7. If a required result is missing, the main agent can repair it and request verification again within the remaining limits.
8. The main agent returns its final answer referencing the stored verdict.
9. The harness accepts that reference only if it is current, then produces the public outcome.

A YouTube window on the external monitor can satisfy the request. The verifier must assess the actual relevant window. A laptop screenshot or a recovered keyboard-focus error alone should not decide the task's outcome.

## Implementation and audit corrections

The repository already has immutable natural-language goals, an explicit verification tool, a read-only verification agent, evidence revisions, execution limits, and public task outcomes.

Before this refactor these controls were spread across `ComputerUseTaskRunner.ts`, `TaskContext.ts`, `CreateComputerUseAgent.ts`, and `TaskVerifier.ts`. The verification tool directly invoked the verifier, while `TaskVerifier.ts` also owned the final completion gate.

The implementation introduces one coordinator, `TaskHarness`, and routes lifecycle decisions through it. Existing permissions, providers, model choice, locale, evidence collection and UI contracts remain the foundation.

The audit reproduced three acceptance gaps with synthetic verifier output: response mode can bypass verification after a read-only desktop observation; an older observation can pass despite a newer contradictory observation at the same mutation revision; and a verdict marked both satisfied and blocked can become success. A fourth finding showed that verifier-only raw observations are unavailable to the next verification attempt.

CompletionGate and the evidence store now address those gates and ownership issues. Regression tests cover each reproduced case. Synthetic probes establish acceptance failures, not the frequency of live-model mistakes.

The goal stays alive across the initial SDK attempt and an optional continuation. An SDK final answer is a proposed result; it cannot independently terminate the application task as successful.

This first version owns one foreground task in memory. App-restart recovery, background scheduling and pause/resume are separate future work because they require persistence and fresh desktop evidence.

## Responsibilities

| Component                | Owns                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Main agent               | Understanding the request, defining criteria, choosing actions, requesting verification and writing the final answer               |
| Task harness             | Lifecycle transitions, original-request ownership, admission controls, verification scheduling, continuation and result settlement |
| Verification agent       | Semantic judgment of the original request using real observations; targeted read-only checks                                       |
| Completion gate          | Verdict consistency, criterion coverage, desktop-use requirements, evidence provenance/freshness and final-reference checks        |
| Cua transport and ledger | Serialized calls, capability enforcement, raw evidence retention, capture ordering, supersession and mutation revisions            |
| Electron main            | Authentication, permission checks, active-session admission and worker timeout                                                     |
| Renderer                 | Existing task UI and locale; no agent orchestration                                                                                |

The verifier reports a judgment. The completion gate validates whether that judgment is usable. The harness makes the final state transition.

## Task state

Keep the task state in `TaskContext.ts`. The independent verification boolean is replaced by an explicit phase, declared through a canonical `as const` object and derived TypeScript type.

| Phase             | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `created`         | Task exists; the main agent has not started                                 |
| `working`         | Main agent may inspect and, after goal acknowledgement, act                 |
| `verifying`       | Main agent is waiting for verification; desktop mutations are rejected      |
| `ready_to_finish` | A current successful verdict exists; main agent may return its final answer |
| `settled`         | A validated succeeded, partial, blocked or unverified result was returned   |
| `stopped`         | User cancellation ended the task                                            |
| `failed`          | Execution failed without a usable task result                               |

Phase and outcome are separate concepts. `settled` does not imply `succeeded`.

The task record holds:

- Worker-assigned task ID and immutable original instruction.
- Locale captured from the existing app hook.
- Immutable goal with worker-assigned criterion IDs.
- Current phase and desktop revision.
- A monotonic `hasUsedDesktopTools` flag and evidence version.
- Latest worker-owned verification record.
- Monotonic model, verification, tool and continuation counters.
- Deadline, cancellation controller and termination reason.

SDK history belongs to the main-agent adapter for continuation. Verification uses a separate worker-owned evidence packet, collected from both agents. The harness does not interpret provider-specific history objects or use previous agent claims as observational evidence.

Allowed transitions are explicit:

| Trigger                                        | Transition or result                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Start task                                     | `created → working`                                                                                   |
| Main agent requests verification               | `working → verifying`                                                                                 |
| Valid successful verdict                       | `verifying → ready_to_finish`                                                                         |
| Partial, uncertain or invalid verdict          | `verifying → working`; return feedback                                                                |
| Observed blocker                               | `verifying → working`; return blocker feedback and admit no automatic repair continuation             |
| Desktop mutation after successful verification | Invalidate verdict; `ready_to_finish → working`                                                       |
| Relevant evidence superseded or expired        | Invalidate verdict; `ready_to_finish → working`; explain that another explicit verification is needed |
| Accepted final proposal                        | `working/ready_to_finish → settled`                                                                   |
| User cancellation                              | Any active phase `→ stopped`                                                                          |
| Exhausted task budget                          | Settle as unverified when a goal exists; otherwise use the existing failed-result contract            |
| Provider or execution failure                  | `→ failed`, unless cancellation already won                                                           |

Terminal phases admit no new model or desktop work. All terminal replies settle pending calls before releasing task-local state. Cancellation cannot later be overwritten by a successful response.

Lifecycle transitions must be synchronous and checked before asynchronous work starts. Do not hold a task-wide mutex across an SDK run: that run calls back into the harness through `verify_task`. The Cua queue serializes desktop operations; it must not contain the verification operation that awaits that same queue.

## Harness controls exposed to the main agent

Preserve the existing model-facing tools.

### define_task_goal

Accept a summary and one to five natural-language criteria. Validate inputs, assign IDs and freeze the result. The main agent must see the tool result in a later model turn before mutations are admitted.

The original instruction remains authoritative. The verifier must reject success if the goal omitted a requested result. No additional planning model is required to create the goal.

### verify_task

Keep its arguments empty. The tool delegates to `TaskHarness.requestVerification()`; the model cannot supply a replacement goal, revision, history, permissions or verdict.

The harness:

1. Checks phase, goal acknowledgement, cancellation and verification budget.
2. Enters `verifying` before awaiting any work, preventing another write from being admitted.
3. Settles queued calls and builds a bounded evidence packet from the original request, goal, locale and admissible observations.
4. Runs the verifier through the read-only verification port.
5. Settles verifier calls and checks cancellation again.
6. Refreshes the evidence packet with verifier observations, then validates verdict consistency, coverage, references, supersession and capture age.
7. Stores a worker-generated verdict ID bound to the task, revision, evidence version and verification time.
8. Returns a bounded verdict summary and any missing-result feedback to the main agent.

An exhausted attempt budget returns bounded feedback without launching another verifier. Repeated calls still consume the shared admitted-tool budget.

The main agent waits for this call to finish. There is no observer loop running concurrently.

### Final output

Preserve the current structured proposal:

```ts
{
  mode: 'response' | 'task',
  answer: string,
  verificationId: string | null
}
```

The harness settles queued tools, validates the proposal and checks the stored verdict reference. The final gate performs no LLM call.

A successful task requires the latest successful verdict for this task, with current revision, admissible cited evidence and an unexpired evidence window. Fabricated IDs, another task's verdict, pending work, superseded evidence or a later mutation prevent success. The final gate rechecks freshness because the main agent's final-answer model call can take time after verification.

Ordinary response mode requires no goal, no desktop tool use, no pending work and a null verification ID. `hasUsedDesktopTools` is set before dispatching any task-scoped Cua call, including read-only discovery, observations and failed calls. Once set, it cannot reset during the task or its continuation. Goal-definition and verification controls are not Cua observations; defining a goal independently makes the request a task.

If desktop tools were used without a goal, reject response mode and return bounded feedback asking the main agent to define a faithful goal and explicitly request verification. Existing observations can be reused if still admissible. If no valid goal is produced before limits are exhausted, return a localized failed result; never forward the actor's unsupported completion claim as ordinary conversation.

This closes the observed read-only bypass. It does not prove that a tool-free conversational answer contains no invented operational claim. Intent classification and live-model evaluation remain necessary; no additional classification LLM is introduced in this refactor.

If the main agent omitted verification or supplied an invalid reference, the harness may continue it once with precise feedback. That continuation asks the main agent to request verification when ready; it does not automatically launch a verifier.

A current partial, blocked or unverified verdict can settle with its explicit limitation when further work is unavailable or the agent concludes it cannot finish.

## Verifier decision contract

Replace the independently assignable `requestSatisfied` and `blocked` booleans with one canonical `VerificationDecision` object and a derived Zod enum/type owned by the worker. Keep a strict root object for SDK structured output:

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

`missingRequirements` identifies requested results omitted from the actor's goal, using bounded natural-language descriptions. It does not modify or weaken the immutable goal. The main agent can satisfy those original requirements and request another verification without redefining the goal. Bound this list to five entries of at most 500 characters each; preserve the existing bounds for criteria, explanations and summary.

The completion gate enforces cross-field invariants:

| Decision     | Required consistency                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`  | The verifier affirms the entire original request; every criterion is satisfied with admissible evidence; no missing requirements remain |
| `needs_work` | At least one criterion is unsatisfied or a missing original requirement is identified                                                   |
| `blocked`    | At least one criterion or original requirement remains unmet, with a bounded explanation of the observed obstacle                       |
| `unknown`    | At least one criterion remains unknown, or the original request cannot be fully assessed and the summary explains the uncertainty       |

Invalid combinations produce unverified feedback; they cannot be stored as a successful verdict. For example, confirmed with an unknown criterion or a nonempty missing-requirements list fails the gate. A claim of being blocked with every criterion satisfied and no missing original requirement is invalid.

The decision is still a model judgment, not code proving semantic intent. Instructions require consideration of the original request, appropriate target identities and observed blocker facts; schema checks enforce consistency of the judgment rather than a special rule for each application. Code can check that an uncertainty explanation exists; it cannot independently prove the explanation is true.

Map confirmed to succeeded. For the other decisions, some supported criteria with remaining criteria map to partial; blocked with no supported criteria maps to blocked; otherwise use unverified. If all listed goal criteria pass but original requirements remain missing or uncertain, use unverified rather than claiming goal counts establish the full request. Preserve the existing public schema invariants; document that supported counts are not independently confirmed when the goal's scope is incomplete.

## Verifier and evidence packet

The existing verifier remains an actual SDK agent. It receives:

- Original instruction and immutable criteria.
- A worker-built packet of relevant actual images, accessibility/text content and validated facts from both agents.
- Worker-owned evidence IDs, target identities, revisions, capture times and ordering.
- The captured task locale.

It can use only observational tools allowlisted by Tro and classified read-only by Cua. Dispatch enforces the restriction in addition to filtering the advertised catalog. The shared task state rejects mutations throughout verification.

The model judges whether observations satisfy the request. Code checks decision consistency, exact criterion coverage, genuine admissible observation IDs, usable content/facts, supersession, capture age, pending calls and verdict identity. There is no growing catalog of semantic predicates such as a special function for “open YouTube.”

Define the packet and its owning types in `TaskEvidencePacket.ts`. It contains the original request, goal, locale, task identity, revision, evidence version and selected observation records. Each observation has its evidence ID, call ID, exact available target identities, observation category, revision, monotonic capture sequence, monotonic capture time and a reference to immutable validated content/facts.

Capture content at the Cua boundary for both main-agent and verifier calls. Do not reconstruct it from an agent summary or a `hasImage`/`hasText` flag. Failed/refused calls may contribute separately labelled diagnostics, but cannot provide success evidence. Validate content at the boundary and reuse the owning schemas/types rather than copying SDK protocol shapes throughout the harness.

Keep raw content in a task-local, bounded in-memory evidence store. Image references point to content stored once; hashes can deduplicate repeated identical image data. Selecting a packet dereferences the admitted content into the verifier's actual model input. No screenshots are written to logs, disk, a database or long-term memory.

Keep full actor history available for its own continuation. The default verifier input excludes actor completion claims, reasoning, earlier verifier verdicts and harness repair messages. A small worker-generated action timeline and failed-call diagnostics may be supplied as labelled context, separately from evidence; they cannot establish satisfaction. Page content remains untrusted data even when its source and provenance are valid.

Verifier observations are retained before their tool results are returned. A later verification can receive their actual content through a new packet, even though the earlier nested SDK history is gone. Only the main-agent adapter owns continuation history; the evidence store owns reusable observations from either role.

## Evidence freshness and supersession

Store both the validated verdict and missing-result feedback. Once any desktop mutation begins, including a failed mutation, invalidate the previous verdict and earlier evidence through the existing revision mechanism.

Mutation revision alone is insufficient. Record capture sequence and completion time when an observation is received, using a monotonic clock. The packet builder and final gate apply the same policy:

1. Only observations from the current task and mutation revision are eligible.
2. A newer snapshot supersedes an older snapshot for the same exact target and observation category. Categories distinguish content, visibility, focus and browser/desktop state so an unrelated fact does not silently replace required content.
3. Explicit structured facts also have latest-observation ordering per target and field. An older record carrying a fact overwritten by a newer record is conservatively inadmissible; request a fresh snapshot if its content is still needed.
4. Superseded records remain historical context only and cannot be cited to support success. This must reject an older visible observation after a newer hidden observation even when the mutation revision is unchanged.
5. Dynamic observations expire after a fixed reuse window. Start with a 10,000 ms default in `TaskCompletionConfig.ts`, inject the clock in tests, and tune from measured provider/desktop latency before release.
6. A saved verdict records the admitted evidence IDs and evidence version. On final output, revalidate its cited observations against the latest ordering and capture-age indexes; a saved success flag alone is insufficient.

Unknown target relationships must remain unknown. Do not merge snapshots by PID alone or infer that one monitor's image proves another monitor's state. Target matching and fact ordering are generic evidence rules, not semantic completion predicates for individual websites.

If evidence is expired or superseded during an explicit verification, the verifier can obtain a targeted read within its normal budget. If that happens after verification while the main agent is producing final output, reject the stale success and use the existing bounded continuation to ask for another explicit verification. If attempts or time are exhausted, return unverified. Do not start an automatic observer, refresh model run or verification loop.

An external user or app can change the desktop between captures without advancing the agent's revision. A reuse window bounds staleness but does not detect every external change or make desktop state atomic. Expose the result as confirmation at observation time; fine-grained external-state monitoring remains future work.

## Ports and construction

Introduce narrow, per-task execution ports in `TaskExecutionPorts.ts`. They return Tro-owned validated values and propagate cancellation. Provider-specific SDK objects stay inside adapters.

Conceptually:

```ts
interface MainAgentPort {
  runFirstAttempt(): Promise<CompletionProposal | null>;
  continueWithFeedback(feedback: string): Promise<CompletionProposal | null>;
  dispose(): void;
}

interface VerificationPort {
  verifyCurrentTask(packet: VerificationEvidencePacket): Promise<unknown>;
}
```

These ports are constructed for one task, with the task's state, signal, locale and limits already bound. The harness supplies a validated evidence packet built by the task-local store; the model cannot choose that context. New read-only observations made during verification enter that same store before the tool response reaches the verifier. Raw verifier output is validated against the refreshed evidence indexes at the completion gate.

Construct the harness first, then create the main-agent adapter using its narrow controls:

```text
TaskContext + Cua connection + task-local evidence store
  → TaskHarness
  → Main-agent adapter with defineGoal/requestVerification callbacks
  → Read-only verifier adapter receiving the harness-built packet
```

The callbacks delegate to the harness; they do not create a second owner of lifecycle state. Only the harness can save verdicts and settle outcomes. Runtime argument validation remains at model tools and IPC boundaries.

## File ownership

| File under src/desktop/worker              | Change                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `TaskHarness.ts`                           | Coordinate initial attempt, explicit verification requests, final gate, one continuation and settlement            |
| `TaskExecutionPorts.ts`                    | Own narrow per-task main-agent and verification execution interfaces                                               |
| `TaskEvidencePacket.ts`                    | Own the validated packet contract, content references, selection policy and byte bounds                            |
| `MainAgentRunner.ts`                       | Wrap SDK runs; own actual history and snapshots; enforce model admission through task controls                     |
| `CompletionGate.ts`                        | Validate desktop-use requirements, decision consistency, coverage, freshness and final references; no SDK calls    |
| `ComputerUseTaskRunner.ts`                 | Keep Cua connection lifecycle and create/delegate to a harness for each request                                    |
| `TaskContext.ts`                           | Own phases, desktop-use flag, evidence/verdict version, counters and cancellation; remove SDK history ownership    |
| `CreateComputerUseAgent.ts`                | Keep SDK agent construction; bind tools to harness controls rather than directly invoking verification             |
| `TaskVerifier.ts`                          | Own the packet-based read-only SDK adapter; verdict contracts live in TaskVerification.ts                          |
| `LoggedCuaServer.ts`                       | Mark desktop use before dispatch, capture content from both roles and enforce task/phase admission                 |
| `CuaTaskEvidence.ts`, `CuaObservation.ts`  | Retain bounded raw observations and validated facts with target identity, category, capture order and supersession |
| `ReadOnlyCuaServer.ts`                     | Preserve observation catalog and dispatch enforcement                                                              |
| `TaskCompletionConfig.ts`                  | Own fixed execution, evidence-age and byte-budget defaults; inject smaller limits/clocks in tests                  |
| `StartAgentWorker.ts`, `AgentDebugLog.ts`  | Wire a common request-byte guard for both SDK agents independently of optional redacted debug logging              |
| `TaskResult.ts`                            | Preserve public outcomes and locale-specific fallback                                                              |
| `TaskGoal.ts`, `TaskCompletionProposal.ts` | Preserve existing goal and final-output schemas                                                                    |

`TaskVerification.ts` owns the canonical decision, verdict schema and worker assessment types. Contract shapes are not duplicated. Public result contracts stay in `src/contracts`; local lifecycle vocabulary stays with the worker.

No database migration, new environment variable, public goal API or IPC progress channel is required for this refactor.

## Limits and cost

Retain the current policy: 15 initial main-agent turns, one continuation of at most 5 turns, 2 verification attempts of at most 3 model turns each, 40 shared admitted tool calls, a 110-second worker deadline and the 120-second main-process backstop.

Evidence defaults are implemented in the same configuration file: 10,000 ms maximum reuse age, 4 MiB maximum encoded evidence-packet size, and 16 MiB maximum retained raw evidence per task. These remain initial engineering limits, not measured performance guarantees. Validate them with representative single/multiple-display captures before release. Account for encoded image data and JSON rather than only decoded image bytes.

The gateway currently admits model request bodies up to 8 MiB. The common model transport must check the fully serialized request before dispatch, including tools and instructions; packet size alone is not sufficient. Apply this guard to both SDK agents even when debug logging is disabled. A byte-limit failure ends as a typed context-budget termination and must not trigger provider retries, extra model compression or silent truncation. The harness maps it to unverified when a goal exists, or the existing failed-result contract otherwise.

Discard obsolete raw observations first when the retained-store limit is reached. Never silently remove required current evidence to make a packet fit. If supported smaller or text-only observations cannot satisfy the request within the byte/turn budgets, return unverified with explicit feedback.

Main-agent history has a separate provider-request size constraint. MainAgentRunner must preserve valid tool-call/result pairs and signal size exhaustion rather than silently truncate required context or launch an extra summarization model. This refactor does not promise that complete actor history is free or fits any request size.

All counters belong to the task, survive continuations and never reset after a failed action or verdict. The common OpenAI client disables automatic provider retries. Request-size failures terminate through the task context-budget path, including errors wrapped by the SDK transport.

The harness itself adds no model requests. A requested verifier still incurs its existing model and image-input cost. Reusing sufficient evidence avoids unnecessary reads; no savings are promised until measured.

Record task IDs, phases, model-call counts, verification counts, tool counts, durations, outcomes and termination reasons as metadata. Do not log raw instructions, screenshots, transcripts, tool arguments or credentials. Add no unrelated telemetry service.

## Completed implementation sequence

1. Specify regression cases for the audited read-only response bypass, contradictory verdict and same-revision superseded evidence. Keep the reported failures visible as required acceptance cases.
2. Fix desktop-use admission and introduce the consistent verification decision contract. Extract those rules into CompletionGate; preserve public result shapes while intentionally correcting invalid acceptance behavior.
3. Add capture ordering, age checks, supersession and bounded raw-content retention. Build verification packets containing reusable observations from both roles.
4. Put actor continuation history in MainAgentRunner, replace full-history verifier input with the packet, and enforce explicit context-size limits.
5. Introduce phase transitions and TaskHarness. Bind model tools to harness controls and give it sole ownership of storing verdicts and settling results.
6. Make ComputerUseTaskRunner delegate task execution while retaining connection startup/cleanup. Preserve shared budgets, cancellation and the single continuation policy.
7. Update instructions, tests and documentation, including decision/schema migration and the new evidence policy.
8. Run final validation after all implementation edits are complete; then evaluate live judgment quality and tune evidence defaults.

Keep the existing authenticated gateway, permissions and utility-worker isolation. No renderer imports SDK execution, and no harness operation bypasses Cua or Electron admission checks.

## Acceptance criteria

Automated tests must establish:

- Goal acknowledgement is required before writes, including a mixed goal/write tool batch.
- A read-only desktop call without a goal followed by response mode is rejected; the desktop-use flag survives continuation and failed calls.
- A tool-free ordinary greeting still settles as a response without a verifier. This test does not establish correctness of every tool-free operational claim.
- Desktop actions do not automatically invoke a verifier.
- Exactly one verifier runs for each admitted explicit request.
- Concurrent or queued writes cannot execute while verification owns the task.
- Verifier tool exposure and runtime dispatch both reject writes.
- The verifier receives the original request, current locale and actual observed content.
- A second verification can reuse the actual image/text captured only by the first verifier; content-presence flags and earlier summaries are insufficient.
- Default verifier input excludes actor completion claims, prior verdicts and repair messages from its evidence section.
- A goal that omits requested work cannot establish success.
- Confirmed with unknown/unsatisfied criteria, missing requirements or absent evidence is rejected; an all-satisfied/no-missing blocked verdict is also rejected.
- Invalid, fabricated, stale or wrong-task verdict references cannot establish success.
- An older visible snapshot cannot support success after a newer hidden snapshot for the same target, even at the same mutation revision.
- Unrelated targets and complementary observation categories do not accidentally supersede each other's content; latest explicit fact ordering remains enforced.
- Evidence expiry during verification can require a targeted read; expiry between verification and final output prevents stale success and launches no automatic verification.
- Encoded packet/store/request-size limits are enforced, duplicate images are stored once, and required evidence is not silently truncated.
- The shared serialized-request guard runs with debug logging disabled; size exhaustion causes no outgoing request or provider retry.
- Missing verification receives at most one continuation with the same goal, history and counters.
- Later mutations invalidate previously successful verification.
- Cancellation during a main run, queued tool or verification ends as stopped with no late success.
- Exhausted attempts, turns, tools and deadlines launch no additional model work.
- Terminal phases reject new work and clean up history, listeners and task evidence.
- SDK tool callbacks can reenter the harness without a task-wide mutex deadlock; competing verification requests do not start multiple verifier runs.
- Typed and voice requests retain the same public result contract.

Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:integration` and `pnpm test:worker` using Node 24 after implementation. Synthetic SDK integration tests must remain credential-free and perform no real GUI mutations.

Before shipping, exercise live macOS and Windows behavior with existing/new YouTube tabs, two monitors, inactive Spaces, recovered focus errors, permission failures and cancellation during verification. Measure success judgments and false-success cases; mock tests cannot establish visual accuracy.

## Reference

[Codex Goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) describes a product harness that retains an objective across work and checks. [Agents SDK agents as tools](https://openai.github.io/openai-agents-js/guides/tools/) provides the specialist-agent mechanism used by Tro. This design does not assume Codex's internal verification algorithm is public or identical to Tro's.
