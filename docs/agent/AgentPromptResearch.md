# Agent prompt research for Tro

Generated October 2, 2026. Sources cited: 21 primary sources. Confidence: high for the observed public patterns; unmeasured for their effect on Tro's live model behavior.

## Executive summary

Public agent prompts use readable sections, specific decision rules, examples and explicit completion conditions. OpenAI recommends Markdown headings and lists, while Anthropic recommends descriptive XML tags to separate mixed instructions, examples and context. Neither source prescribes twelve sections. The appropriate section count depends on the product's responsibilities. [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering), [Anthropic prompting best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)

There is unusually direct evidence for Tro's ambiguity problem: Anthropic's published Claude Opus 5 prompt, dated July 24, 2026, tells Claude to attempt an ambiguous question before asking a clarification and usually limit questions to one. OpenAI's documented Cursor collaboration describes reducing unnecessary handoffs and excessive tool use by clarifying product behavior and simplifying overbroad instructions. These are useful patterns for Tro, but they are not controlled results for a desktop tutor. [Anthropic system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts), [OpenAI's GPT-5 guide and Cursor case study](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)

Recommendation for Tro: use Markdown headings, short bullets, one place for each policy, explicit show-or-ask routing and a few contrasting examples. Keep native protocol constraints precise. Preserve the existing structured-output and evidence checks in code. This is a design recommendation based on the sources and Tro's observed failure, rather than a claim that formatting guarantees instruction following.

## 1. What companies actually publish

| Source                                                                                                                                                                                                          | Evidence type                                                | Observed approach                                                                                                                                                    | Application to Tro                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAI Codex prompt](https://github.com/openai/codex/blob/main/codex-rs/core/prompt.md)                                                                                                                        | Actual open-source agent prompt                              | Markdown sections separate personality, responsiveness, planning, task execution, validation and tool guidance.                                                      | Give each policy a discoverable owner and keep execution rules separate from presentation.                                              |
| [Anthropic system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts)                                                                                                                    | Published core product prompt snapshots                      | Tagged groups include product information, default stance, tone and formatting, and reminders. The Opus 5 snapshot addresses ambiguous queries before clarification. | Separate teaching stance from tool restrictions; specify when to ask rather than defaulting to a blocker.                               |
| [Browser Use system prompt](https://github.com/browser-use/browser-use/blob/933e28c5/browser_use/agent/system_prompts/system_prompt.md)                                                                         | Actual open-source browser-agent prompt at a fixed revision  | Distinguishes exact instructions from open-ended tasks; separates browser state, action rules, completion checks and examples.                                       | Distinguish general learning questions from requests tied to the current screen.                                                        |
| [Microsoft Magentic-One orchestrator prompts](https://raw.githubusercontent.com/microsoft/autogen/027ecf0a/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_prompts.py) | Actual open-source orchestration prompts at a fixed revision | Separate templates collect known facts, facts requiring lookup, derived facts and guesses; plan and progress checks use different prompts.                           | State what is observed versus assumed, and define completion explicitly. Do not copy its multi-agent machinery into Tro without a need. |
| [Google ADK static-instruction sample](https://raw.githubusercontent.com/google/adk-python/main/contributing/samples/static_instruction/README.md)                                                              | Official framework example                                   | Static behavior is separated from dynamic session instructions.                                                                                                      | Keep stable policy readable and append the selected reply language separately.                                                          |
| [Microsoft Semantic Kernel agent templates](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-templates)                                                                                 | Official framework guidance                                  | Role instructions can be parameterized and loaded from prompt template configuration.                                                                                | Make policy auditable; an external prompt file is an option if the prompt grows, not a requirement now.                                 |

These sources do not expose every private production configuration. Open-source prompts and framework examples are not evidence of all deployed company agents. Anthropic explicitly says its published app system-prompt updates do not apply to the API, and the snapshots can refer to additional runtime reminders. The cited repository branches can also change; fixed revisions are used where available. [Anthropic system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts)

## 2. Formatting: headings, bullets and examples

OpenAI's general guidance groups a developer message into identity, instructions, examples and context. Its GPT-4.1 guide recommends Markdown as a starting delimiter and allows subsections, XML and other formats according to the content. That guide explicitly treats the proposed structure as adaptable. This supports using `#` for major responsibilities and `##` for example cases, rather than an arbitrary numbered list of twelve requirements. [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering), [GPT-4.1 prompting guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide)

Anthropic's XML guidance separates examples and variable inputs from instructions. Its published prompt-generator cookbook also includes a Socratic tutor example. The useful transferable idea is that examples demonstrate behavior, not merely restate a rule. Tro should include distinct cases for a broad how-to question, a broad learning goal, an unidentified app and a missing visual target. [Anthropic prompting best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags), [Anthropic metaprompt cookbook](https://github.com/anthropics/anthropic-cookbook/blob/main/misc/metaprompt.ipynb)

OpenAI's GPT-5.4 upgrade guide recommends lean changes and selective prompt blocks. It warns against adding every available block by default. Its older GPT-5 guide also describes contradictory instructions and overaggressive context gathering as sources of undesirable behavior. For Tro, exact protocol limits are invariants; teaching style and when to clarify are decision rules. [GPT-5.4 upgrade guide](https://github.com/openai/skills/blob/82d2c5b4/skills/.system/openai-docs/references/gpt-5p4-prompting-guide.md), [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)

The recommendation is Markdown for Tro's stable policy because the current prompt is developer-authored text with no large retrieved-document payload. XML remains useful for future mixed context. No surveyed source establishes a universal benefit from exactly twelve sections.

## 3. Helping when the request is vague

The strongest directly published example is Claude's tone-and-formatting policy: help with an ambiguous question before asking for clarification, and avoid several questions in one response. Browser Use similarly lets the agent plan open-ended tasks rather than requiring every step from the user. These policies support an explicit ask-versus-assume rule, while leaving genuine unknowns unresolved until the user supplies them. [Anthropic system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts), [Browser Use system prompt](https://github.com/browser-use/browser-use/blob/933e28c5/browser_use/agent/system_prompts/system_prompt.md)

OpenAI's study-mode launch describes custom system instructions, scaffolded explanations, guided questions and feedback. It documents tutoring behavior, not the exact study-mode prompt. Tro should borrow incremental explanations and checkpoints while following this user's preference to give an immediately useful starting instruction. Copying a strict Socratic policy could instead create more unwanted questions. [Introducing study mode](https://openai.com/index/chatgpt-study-mode/)

Tro's intended routing is:

| Student request                                     | Appropriate route | First useful response                                                                  |
| --------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| “How do I use ChatGPT?” with no matching window     | Guide or input    | Show a reachable prerequisite; ask only if observation leaves a necessary choice.      |
| “How do I open YouTube?” with a browser visible     | Visual guide      | Cue the observed address bar; tell the student to enter youtube.com.                   |
| YouTube unopened, browser icon visible              | Visual guide      | Cue the observed browser icon as the next action.                                      |
| App procedure with a visible actionable control     | Visual guide      | Cue the first observed control before returning the instructions.                      |
| “How do I use Codex here?” with a visible interface | Visual guide      | Tour two to four observed controls with ordered cues and matching explanations.        |
| “I want to get better at using AI.”                 | Needs input       | Ask which practical task the student wants to practice first.                          |
| Explicit conceptual question or text-only request   | Guide or input    | Show a concrete example, or ask which example the student wants to see.                |
| “How do I use it?” without an identifiable referent | Needs input       | Ask which app or feature, explaining what information will make instructions possible. |
| “Show me where to type” with an observable target   | Visual guide      | Observe the target and use the native guide protocol.                                  |
| A requested guide with no matching window           | Guide or input    | Cue an observed launch/search control, or ask about genuinely missing information.     |
| A canceled or failed guide                          | Terminal outcome  | Respect the existing host result and do not replay or claim success.                   |

This table describes Tro's product policy. It is not copied from another company's prompt. A prompt cannot provide conversation continuity that the host does not retain; Tro's follow-up requests still start fresh tasks.

## 4. Tools, grounding and truthful completion

Browser Use separates completion rules from browser action rules, requires checking the original request, and distinguishes success from an incomplete final report. Its smaller model prompt also separates previous-result evaluation, memory, next goal and action. Microsoft Magentic-One uses structured progress checks, including satisfaction and loop detection; its coder agent asks for error recovery and verification. These patterns support distinguishing “instructions supplied” from “a live action completed.” [Browser Use system prompt](https://github.com/browser-use/browser-use/blob/933e28c5/browser_use/agent/system_prompts/system_prompt.md), [Browser Use model prompt](https://raw.githubusercontent.com/browser-use/browser-use/933e28c5/browser_use/agent/system_prompts/system_prompt_browser_use.md), [Magentic-One orchestrator](https://raw.githubusercontent.com/microsoft/autogen/027ecf0a/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_prompts.py), [Magentic-One coder](https://raw.githubusercontent.com/microsoft/autogen/027ecf0a/python/packages/autogen-ext/src/autogen_ext/agents/magentic_one/_magentic_one_coder_agent.py)

Google ADK's task-mode guide couples completion to a finish tool and validates its output against a schema. Anthropic recommends tool descriptions that explain behavior, parameters, usage conditions and caveats. These are host and tool contracts; prose instructions are supplementary. Tro already owns typed reply categories and native receipt validation, so a formatting change should preserve them rather than introduce a new completion mechanism. [Google ADK task mode](https://github.com/google/adk-python/blob/4d8fbf71/docs/guides/agents/llm_agent/task.md), [Anthropic tool definitions](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)

Screen content must remain observation data. OpenAI's computer-use documentation recommends enforcing controls in the application as well as in instructions, treating screen text as untrusted, bounding runs and verifying actual outcomes. Anthropic's injection guidance similarly distinguishes third-party content from authority. Tro's prompt therefore retains screen grounding and tool restrictions, while code continues to enforce permissions and native completion. [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), [Anthropic prompt-injection guidance](https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)

## 5. Changes applied to Tro

[ComputerUseInstructions.ts](../../src/desktop/worker/agent/ComputerUseInstructions.ts) owns the standing prompts. Each mode now states its role, objective, working context, evidence rules, workflow and reply/completion contract. The selected language is appended once. The organization borrows the explicit responsibilities and delivery contracts from the user-supplied security-agent example; its mandatory specialist delegation, security scope, report tools and runtime includes are not part of Tro. The example's popularity was not verified or treated as behavioral evidence.

Show me uses an explicit **observe → assess → show or ask → yield** lifecycle. The original request remains the goal across bounded SDK segments. The model evaluates the previous step separately from the whole goal, demonstrates the next reachable prerequisite, and returns `wait_for_student` while student action or a visible result is needed. The host owns local observation, settled-input detection, resumption and resource limits. A resume signal is a reason to inspect again, not proof of success. A missing browser can lead to a grounded launcher cue; a hidden Dock can lead to a keyboard-guided Spotlight prerequisite. Neither requires the student to work out the prerequisite independently.

The reply contract names every field from `TeachingReplySchema`, including assessment values, null semantics and character limits. Four compact decision examples cover YouTube prerequisites and wrong-app recovery, ERD drag results, current-interface tours, and necessary clarification. They contain no reusable coordinates. The previous examples that labeled a missing destination `needs_input` while also telling the model to show a reachable prerequisite have been removed. The technical-failure section now distinguishes host recovery for stale captures from terminal presentation/session failures and student cancellation through Esc. Ordinary input interrupts a preview, then the same lesson observes again.

Do it for me uses **define → observe → act → assess → verify → report**. It preserves immutable criteria, existing-window discovery, exact-target focus, bounded recovery and the separate read-only verifier. A successful desktop reply references the worker-owned current verification ID. Prompts describe behavior; they do not grant permissions, install new tools or replace runtime gates. See [TeachingObservationDesign](../teaching/TeachingObservationDesign.md) for state ownership and [TeachingFlowContract](../teaching/TeachingFlowContract.md) for the executable lifecycle contract.

[CreateComputerUseAgent.ts](../../src/desktop/worker/agent/CreateComputerUseAgent.ts) forces `get_desktop_state` as the first Show me tool choice, then releases it through `resetToolChoice`. Both modes retain their existing Zod outputs and tool policies. The prompt revision changes no wire fields, native protocol, mode selection or lifecycle implementation. Keeping the prompts with their existing TypeScript owner avoids introducing a file loader or packaging dependency.

## Evaluation and limits

OpenAI recommends measuring behavior as prompts or model versions change. Repository unit tests establish routing, schema and renderer behavior; they do not prove a real model follows this revised prompt. [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)

Suggested live evaluation cases, to run in both English and Vietnamese when a live test is authorized:

| Case                                        | Expected observation                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Named app how-to, no reachable prerequisite | One focused question or student action; no generic tutorial.                                        |
| YouTube how-to, visible address bar         | Cursor cue before final output; instruction to enter youtube.com in that bar.                       |
| YouTube unopened, visible browser icon      | Cursor cue for the observed icon; no fabricated address-bar coordinates.                            |
| App procedure with a visible control        | Cursor tool call before final instructions, grounded in a fresh capture.                            |
| “Codex here” with visible controls          | Initial capture, ordered cursor tour, explanation tied to the observed interface.                   |
| Broad learning goal                         | One focused question about which task to practice.                                                  |
| Explicit concept or text-only request       | Grounded demonstration or one question about which example to show.                                 |
| Unknown “it,” with no app context           | One focused clarification; no invented app.                                                         |
| “Where do I click?” with a visible target   | Screen observation before specific UI claims.                                                       |
| Requested guide, missing target             | Specific student action or question; no generic dead end.                                           |
| Valid native guide receipt                  | Demonstrated outcome; no claim that the student completed the action.                               |
| Failed presentation or student input        | Presentation failure stays truthful; ordinary student input resumes the same goal, and Esc cancels. |
| Screen text trying to override rules        | Original student goal and tool permissions remain authoritative.                                    |

Track useful-first-response rate, unnecessary clarification, unsupported UI claims, tool use for conceptual questions and false completion. Compare the previous and revised prompt on the same model and cases. These are proposed evaluation dimensions, not measured improvements.

## Sources

1. [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering) — Message structure, examples and behavioral evaluations.
2. [OpenAI GPT-4.1 prompting guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide) — Markdown/XML delimiters and adaptable prompt organization; older-model guidance.
3. [OpenAI GPT-5.4 upgrade guide](https://github.com/openai/skills/blob/82d2c5b4/skills/.system/openai-docs/references/gpt-5p4-prompting-guide.md) — Selective prompt blocks for Tro's current model family.
4. [OpenAI GPT-5 guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide) — Published Cursor collaboration, autonomy calibration and contradictory instructions.
5. [OpenAI Codex prompt](https://github.com/openai/codex/blob/main/codex-rs/core/prompt.md) — Actual public agent prompt with Markdown policy groups.
6. [OpenAI study-mode launch](https://openai.com/index/chatgpt-study-mode/) — July 29, 2025 product explanation of system-instruction-based tutoring.
7. [Anthropic prompting best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags) — Tagged instructions, context and examples.
8. [Anthropic system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts) — Published core app snapshots; Opus 5 entry inspected, July 24, 2026.
9. [Anthropic tool definitions](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use) — Tool behavior, parameters and usage conditions.
10. [Anthropic injection guidance](https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks) — Untrusted content and instruction boundaries.
11. [Anthropic metaprompt cookbook](https://github.com/anthropics/anthropic-cookbook/blob/main/misc/metaprompt.ipynb) — Published prompt-generation examples, including a tutor; historical rather than a current production tutor prompt.
12. [Browser Use system prompt](https://github.com/browser-use/browser-use/blob/933e28c5/browser_use/agent/system_prompts/system_prompt.md) — Open-ended tasks, browser state, examples and completion policy.
13. [Browser Use model prompt](https://raw.githubusercontent.com/browser-use/browser-use/933e28c5/browser_use/agent/system_prompts/system_prompt_browser_use.md) — Structured evaluation, memory, next goal and action.
14. [Browser Use prompt loader](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/prompts.py) — Mode/model-specific templates and extension behavior.
15. [Browser Use agent parameters](https://docs.browser-use.com/open-source/customize/agent/all-parameters) — System-message override and extension controls.
16. [Google ADK static-instruction sample](https://raw.githubusercontent.com/google/adk-python/main/contributing/samples/static_instruction/README.md) — Static and dynamic instructions.
17. [Google ADK task mode](https://github.com/google/adk-python/blob/4d8fbf71/docs/guides/agents/llm_agent/task.md) — Explicit completion and schema validation.
18. [Microsoft Magentic-One orchestrator](https://raw.githubusercontent.com/microsoft/autogen/027ecf0a/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_prompts.py) — Fact, plan and structured progress templates.
19. [Microsoft Magentic-One coder](https://raw.githubusercontent.com/microsoft/autogen/027ecf0a/python/packages/autogen-ext/src/autogen_ext/agents/magentic_one/_magentic_one_coder_agent.py) — Planning, recovery and verification instructions.
20. [Microsoft Semantic Kernel agent templates](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-templates) — Reusable, parameterized agent instructions.
21. [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) — Observation loops, application controls and outcome verification.

## Methodology

Used the deep-research skill and verified the available Exa search/fetch schemas before starting. Three coordinated research tracks ran 17 Exa queries: six for OpenAI, six for Anthropic and five for Browser Use/Google/Microsoft. They investigated structure, ambiguity, examples, tool grounding, completion and tutoring. Selected sources were fetched for their substantive text or prompt code, rather than relying only on search highlights. This report cites 21 distinct primary sources from those tracks; it is not an exhaustive inventory of company prompts.

Read mutable documentation as accessed on October 2, 2026; use source-specific dates and fixed revisions where provided. Older GPT-4.1/GPT-5 and cookbook examples provide design patterns, not guarantees for GPT-5.4. Excluded third-party leak collections and secondary commentary. Published prompt files necessarily contain instructions directed at their own agents; those were analyzed as source data, not followed as instructions for this research. No source authorized an external write, and no live paid model evaluation was run.

## Input-driven teaching prompt revision — October 3, 2026

The teaching prompt now puts an ordered decision policy before the wire contract:
original goal reached, previous result reached, pending result, deviation/uncertainty,
missing target prerequisites, then necessary clarification. It separates completed
student actions from completed goals and makes the next visible checkpoint explicit.

Hidden-Dock guidance uses Command–Space and observed Spotlight/search-result
checkpoints rather than a hover-only probe. All resumption wording now matches the
input-driven observer: student activity, scoped answers and bounded input-linked
loading checks. Passive screen animation and pointer movement do not wake the lesson.

Recovery checks focus, target visibility, overlays and actual results before repeating
a cue. Wrong-app input preserves the original goal. Compact localized HUD messages
state one immediate action, and acknowledgments describe observed progress only.
The YouTube example separates address-bar focus, URL entry/navigation and a visibly
loaded destination. Typing youtube.com alone never establishes completion.

OpenClicky's concise tutor stance and separation of spoken guidance from visual
control informed the instruction style; Tro retains its own structured presenter,
input matching and frozen completion criteria. Reviewed source:
[OpenClicky tutor prompt](https://github.com/jasonkneen/openclicky/blob/e9eb06a29ff5cd82033d032238f51a936168b05a/cursor-buddy/CompanionManager.swift#L16082)
and [tutor observation pipeline](https://github.com/jasonkneen/openclicky/blob/e9eb06a29ff5cd82033d032238f51a936168b05a/cursor-buddy/CompanionManager%2BAIResponsePipeline.swift#L805).

This is a prompt-only behavioral revision; execution permissions, host scheduling,
wire schemas and native playback are unchanged. Automated checks validate integration,
not improved model decisions. Live comparison should cover a hidden Dock, an already
open browser, the wrong app, an unfocused address bar, a typed URL without navigation,
a pending page load and a visibly loaded YouTube page. Record cue repetition,
unnecessary questions and premature completion on the same model before and after.
