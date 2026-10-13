# Optimizing AI-generated Remotion lessons

Research date: October 12, 2026. Research and proposals only; this document does not describe new implemented behavior. The maintained runtime architecture remains [Architecture.md](../docs/Architecture.md).

## Finding

Creative Remotion generation does not require an agent that repeatedly rewrites an entire video. The strongest recurring patterns are small generation tasks, selected examples, focused patches, saved scene artifacts and separate rendering retries. These preserve more creative freedom than a closed animation vocabulary while containing the work that can fail.

There is no verified universal cost per Remotion video in the sources inspected. Public templates demonstrate techniques; they do not establish production reliability or a guaranteed dollar saving. The most useful quantitative evidence comes from related Manim research and needs validation on Tro.

## Questions and method

The research covered five questions:

1. How does Remotion itself build AI code generation?
2. How do public implementations reduce context and repair scope?
3. What measured evidence exists for reducing animation-generation cost?
4. Which optimizations affect model tokens versus rendering compute?
5. How can Tro add creative animation without restoring its previous open-ended loop?

Searches combined official Remotion documentation, public implementation code, model-provider documentation and animation-generation papers. Queries covered AI skills, prompt-to-motion-graphics, targeted repairs, scene regeneration, prompt caching, browser reuse and rendering performance. Exa and Firecrawl were unavailable, so ordinary web search and direct primary-source reads were used. Two research subtasks examined implementation examples and cost evidence. External prompts and agent instructions were read as source material, not executed.

## 1. What Remotion's own implementation does

Remotion's [AI SaaS starter](https://www.remotion.dev/docs/ai/ai-saas-template) generates React animation code and supports targeted edits. Its [code-generation guide](https://www.remotion.dev/docs/ai/generate) recommends selecting relevant skills instead of loading all guidance into every request. A structured output can contain source code and metadata; JSON validity alone does not establish executable or visually correct code.

The inspected starter, pinned to commit `610e01dd73d60723d18f713a2cb8b188dffea849`, has several useful details:

| Technique                    | Source evidence                                                                     | Implication for Tro                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Selected skills and examples | The generation route injects selected guidance.                                     | Send the small API/example subset needed for the scene.             |
| Compact edit context         | Follow-ups use current code and the last six messages.                              | Avoid sending every historical source revision.                     |
| Focused edits                | Unique search/replace blocks can update a small region.                             | Repair a specific component instead of regenerating a lesson.       |
| Extra model calls            | Initial generation performs prompt validation, skill selection and code generation. | A starter's orchestration is not automatically the cheapest design. |

These behaviors are visible in the [generation route](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas/blob/610e01dd73d60723d18f713a2cb8b188dffea849/src/app/api/generate/route.ts). Its [conversation state](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas/blob/610e01dd73d60723d18f713a2cb8b188dffea849/src/hooks/useConversationState.ts) replaces older assistant code with a placeholder rather than accumulating full copies.

Do not copy its cost controls unquestioningly. The inspected route has no explicit dollar or output-token cap. The UI declares a correction limit, but streaming startup resets correction state; source inspection is insufficient to claim an effective server-enforced bound. Tro should enforce attempts and reservations on the backend. See the [page](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas/blob/610e01dd73d60723d18f713a2cb8b188dffea849/src/app/generate/page.tsx), [correction hook](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas/blob/610e01dd73d60723d18f713a2cb8b188dffea849/src/hooks/useAutoCorrection.ts) and [request hook](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas/blob/610e01dd73d60723d18f713a2cb8b188dffea849/src/hooks/useGenerationApi.ts). This was not a reproduced bug investigation.

## 2. Reuse can preserve creative code

[Video Shotcraft](https://github.com/Vincentwei1021/video-shotcraft) combines reusable motion recipes, shared components and editable Remotion implementations. This offers a useful middle ground: the AI starts with working animation patterns and can compose or customize them. A recipe library need not restrict output to a fixed set of slides. The repository does not establish measured per-video cost.

[Outscal's generator](https://github.com/outscal/video-generator) saves scripts, assets and scene code in separate files. Its [code-agent instructions](https://github.com/outscal/video-generator/blob/a1e9237aba194e93d19c2e70a334d5cdcf61d0ed/.claude/agents/code-agent.md) describe resubmitting only failed components and loading additional rules on demand. However, its repeat-until-success instruction has no explicit repair bound. Its five-agent architecture is evidence of one implementation, not a requirement or proof of efficiency. Direct adoption would also require correcting its ASCII-only assumption for Vietnamese lessons.

Remotion also provides a [prompt-to-video template](https://github.com/remotion-dev/remotion/blob/main/packages/template-prompt-to-video/README.md) that represents the result as a timeline containing elements, text and audio. Thus structured animation data and generated code are both legitimate approaches; the content's needs should determine which earns its complexity.

## 3. What has actually been measured

[Code2Video](https://arxiv.org/html/2510.01174v1), October 2025, reports this efficiency ablation in Table 7:

| Repair approach                                   | Average tokens per topic | Average generation time |
| ------------------------------------------------- | -----------------------: | ----------------------: |
| Localized ScopeRefine with parallel generation    |                    30.8K |            15.4 minutes |
| Debug with full code and error logs               |                    42.1K |            39.2 minutes |
| Regenerate a section after an error               |                    49.8K |            42.9 minutes |
| Localized ScopeRefine without parallel generation |                    30.8K |            86.6 minutes |

The local repair scope expands only when necessary. Parallelism reduced elapsed time here, not token usage. These are Manim benchmark results, not Remotion measurements or Tro forecasts. They do not contain the billing breakdown needed to calculate our cost. We can adopt the isolated-repair principle without adopting the paper's full planner/coder/critic architecture.

[Training and Agentic Inference Strategies for LLM-based Manim Animation Generation](https://arxiv.org/html/2604.18364v1), April 2026, uses current code, the last ten error lines and selected API documentation. Its main correction experiment allows one repair. A specialized trained model reaches 94% render success on a 100-example held-out set; this is not a promise for an off-the-shelf model. Some models worsened with dense documentation. Successful execution also does not prove that an animation teaches correctly.

[LLM2Manim](https://arxiv.org/html/2604.05266v1), April 2026, separates narration and visuals and supports partial regeneration. It still documents human review and manual visual corrections. This supports independent artifacts and retries, not an assumption of flawless autonomous generation.

## 4. Context, persistence and caching solve different problems

[Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) supports concise examples, retrieving information when needed and removing redundant tool results. For Tro, that suggests a scene brief plus relevant material, rather than the whole repository and every earlier failure.

Two distinctions matter:

- **Conversation persistence is not free context.** OpenAI documents that earlier input in a `previous_response_id` chain remains billable. Saving response IDs does not eliminate repeated input cost. [Conversation-state documentation](https://developers.openai.com/api/docs/guides/conversation-state).
- **Prompt caching is not saved output.** Caching benefits matching prompt prefixes. It does not avoid generating fresh source code, and savings depend on the model and actual cache hits. Put stable instructions and examples first, variable scene material later, and measure the result. [Prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching).

Store accepted scene source/data and rendered media durably. Those application artifacts let a failed render resume without another AI request. Provider caching cannot substitute for them. Conversely, retaining every historical artifact does not mean sending every artifact back to the model.

## 5. Render optimization is a separate budget

Remotion's [SSR example](https://www.remotion.dev/docs/ssr-node) explicitly supports bundling once and varying input props for multiple renders. Its [openBrowser API](https://www.remotion.dev/docs/renderer/open-browser) supports reusing a browser across render calls, reducing repeated startup work.

Its [performance guidance](https://www.remotion.dev/docs/performance) recommends measuring concurrency, avoiding expensive effects on machines without suitable GPU acceleration, reducing external fetches and selecting appropriate resolution and encoding. More concurrency can be slower or consume excessive memory. These changes affect render duration and infrastructure cost; they do not reduce model tokens already spent.

Tro already uses a prebuilt bundle. Its current renderer sets concurrency to one and does not supply a shared browser instance. Browser reuse and a small concurrency benchmark are concrete candidates, but neither should be presented as a fix for the old multi-million-token generation loop.

## 6. Recommendation for Tro

**This is a proposal, not an implemented change.** Keep the current structured generation as the reliable baseline. Experiment with a small code-generating scene task for explanations that benefit from more expressive animation. Do not rebuild a general project-editing agent.

```text
Teacher request + selected class material
                   |
          Bounded lesson planning
                   |
          Save narration and scenes
                   |
           For each scene independently
                   |
       +-----------+----------------+
       |                            |
 Reusable animation          Custom scene component
 and structured data         + selected working recipes
       |                            |
       |                     Compile / execution check
       |                            |
       |                     At most one focused repair
       |                            |
       +-------------+--------------+
                     |
             Save accepted artifact
                     |
      Existing speech + Docker render worker
                     |
         Save clips -> assemble -> teacher views
```

The proposal has two model responsibilities: lesson planning and optional scene coding. A responsibility is not a permanently running agent. The render worker is ordinary software. No separate AI reviewer is required.

Trusted code should own composition registration, fonts, captions, narration timing and the overall canvas. A generated component should own only the instructional visual: for example, moving digits into groups, drawing a number line or transforming an equation. This offers more expressive freedom than requiring every idea to fit a fixed action enum.

For repair, send only the latest scene source, its brief and the relevant error. Do not send previous code revisions, all lesson scenes or repeated full logs. Start with a backend-enforced allowance of one repair and evaluate whether a second earns its cost. This count is a proposed policy, not an industry-proven optimum.

Keep compile/execution checks distinct from the old layout-review loop. Fixed layouts need no new AI layout critic. Custom code requires basic execution checks; successful compilation cannot guarantee good visuals. Let teachers inspect the output. A bounded representative-frame preview can aid debugging without creating an automated perfection loop.

If custom generation exhausts its allowance, use the saved narration and a clear baseline scene. Tell the teacher that enhanced animation was unavailable. A render-worker outage instead leaves saved work retryable; no architecture can guarantee an MP4 while rendering infrastructure is unavailable.

Generated code introduces a new execution boundary. Remotion's [browser bundler](https://www.remotion.dev/docs/browser-bundler) explicitly accepts trusted code and is not a sandbox; its [dynamic-compilation guide](https://www.remotion.dev/docs/ai/dynamic-compilation) also warns about executing code in browser scope. Do not evaluate model-generated TSX in Tro's authenticated Electron renderer. Any future custom-code experiment needs isolated execution without application credentials or unrestricted network access. The current trusted-template Docker worker should not be assumed to provide that isolation automatically.

## 7. Budget and recovery rules

Calculate model spend from uncached input, cached input and output separately:

```text
model cost = sum over attempts (
  uncached input tokens * input rate
  + cached input tokens * cached rate
  + output tokens * output rate
)

total cost = model cost + speech + rendering + storage/transfer
```

Reserve capacity before each paid attempt, including transport retries. An interrupted response may have consumed provider work even when usage was not returned; keep that uncertainty visible. A smaller model is only cheaper overall if its extra failures and repairs do not erase the price advantage.

| Failure                         | Proposed recovery                                                        |
| ------------------------------- | ------------------------------------------------------------------------ |
| Scene compilation fails         | One focused repair, then baseline scene.                                 |
| Render connection breaks        | Retry saved scene artifact; no model regeneration.                       |
| Worker restarts                 | Resume missing clips from durable job state.                             |
| Teacher changes one explanation | Invalidate that scene and its dependent media.                           |
| Animation budget runs out       | Preserve completed scenes and use baseline scenes for remaining content. |

## 8. Current code and next experiment

The current [content adapter](../src/server/features/lessonVideos/infrastructure/OpenAiLessonContent.ts) requests structured lesson data and explicitly excludes generated code. [LessonVideoConfig](../src/server/config/LessonVideoConfig.ts) owns request limits and budget policy. [RenderLessonClip](../src/lessonRenderer/RenderLessonClip.ts) renders the trusted bundle. This research does not establish the precise historical cause of the previous six-million-token job; that would require its per-attempt trace.

Before choosing a new provider or enabling custom scenes, benchmark 20–30 representative Vietnamese lessons, including counting, Boolean logic, fractions, sorting and process diagrams. Compare:

1. Current fixed layouts.
2. Composable animation data with reusable components.
3. One generated scene component with selected recipes and one permitted repair.

Keep lesson inputs and target durations comparable. Measure first-pass render success, teacher acceptance, repairs, uncached/cached/output tokens, speech cost, render seconds, peak memory and p50/p95 completion time. Include failed attempts in cost per accepted video. Use identical tasks to compare candidate models; provider price alone cannot establish the winner.

The decision should follow measured teaching quality and completed-video cost. The evidence supports smaller context, reusable motion code, focused repairs and durable artifacts. It does not justify reintroducing an unbounded agent or promise that every custom animation can finish cheaply.
