# Guided Lesson Rebuild — Historical Design

Status: historical planning snapshot, archived October 12, 2026.
This preserves the requested design discussion; it is not a maintained runtime specification.
Current behavior, configuration ownership and recovery guarantees belong to
[Architecture.md](../docs/Architecture.md). Paid model benchmarks and production
deployment were outside this implementation.
Date: October 12, 2026.
Baseline: `main` at `1d4ec9c`.

The teacher describes the video they want, selects class materials and clicks
**Create video**. Tro generates a
small set of structured screens, saves them, and renders their content with
maintained animated Remotion templates and narration. The teacher decides whether the content is
useful. Creation does not require an AI reviewer or approval workflow.

This is the requested planning artifact; implementation details and accepted beta limits are maintained in Architecture.md. [Architecture.md](../docs/Architecture.md) remains
the maintained description of the implemented system. Keep this snapshot historical.

Sections 1–11 describe the original fixed-layout baseline. Section 12 extends that
baseline with optional AI-generated scene visuals. Statements below that exclude
generated code apply to the original delivery. Section 12 records the extension;
Architecture.md describes the current runtime and its supported limits.

## 1. Decisions

| Area          | Decision                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI output     | Structured screen data, selected by the user; no generated React, CSS, shell commands or project files.                                                   |
| Model work    | One content-generation request normally produces the whole lesson. No agent tools or conversation loop.                                                   |
| Visuals       | Three fixed Remotion templates with maintained content animations. Template choice and text are data.                                                     |
| Checking      | Basic data-shape and size limits only. No runtime layout checker, AI reviewer or layout-repair loop.                                                      |
| Storage       | PostgreSQL owns source snapshots, screens, job state and completed media. Memory and container files are temporary.                                       |
| Recovery      | Resume from saved stages; expose saved screens immediately and support video with missing narration. A media failure must not trigger content generation. |
| Local runtime | Native API and Electron; Docker for the video renderer and the existing development database.                                                             |
| Production    | Existing Railway API and PostgreSQL plus one Docker renderer service on the private network.                                                              |
| Scope         | Teacher creates, edits, watches, downloads and deletes private lesson videos. Classroom publishing and student interaction are later increments.          |

The retained onboarding video remains a coming-soon preview until the corresponding
product behavior is available. Do not promise student publishing merely because
teacher video generation is complete.

## 2. The generation path

```text
Teacher selects material + goal
             |
             v
API saves source snapshot and starts the job
             |
             v
Content generator: ONE request for all screen JSON + narration
             |
             v
API saves structured screens in PostgreSQL
             |
             v
For each screen, sequentially:
  Speech synthesis   --> save audio + measured duration
             |
             v
  Animate content in fixed template --> render and save clip
             |
             v
Combine saved clips --> save final MP4 --> Ready to watch
```

The product path is **generate content → save → create narration → animate and
render video**. Persistence checkpoints completed work along the way.

1. The backend snapshots the selected material and teacher goal, then requests a
   lesson title and 3–6 screens with narration from the model.
2. Parse the response at the boundary, assign stable screen IDs and save screen
   data immediately. Basic parsing enforces usable fields and size limits; it does
   not judge visual layout or educational quality.
3. Make saved screens and their transcript available immediately. Generate narration
   once per screen and persist the audio and duration; use the text-only fallback
   in section 6.6 when speech cannot complete within its allowance.
4. Pass saved screen data and audio into a maintained animated template. Render
   and save each clip, then combine the completed clips. Save the final MP4 before
   reporting completion. There is no visual-validation stage in this path.

There is one AI content role. Speech synthesis and rendering are services, not
additional agents. Use the installed OpenAI client for structured output; an
Agents SDK run adds no useful behavior to this initial path.

### 2.1. How many agents and workers?

**For this feature: one AI content generator, zero autonomous/tool-calling agents,
one application job runner and one renderer service.** This count does not include
Tro's existing computer-use or teaching agents; this feature does not call or
modify those agents.

The content generator is the only component that makes language-model content
decisions. Calling it an "agent" in conversation is fine, but its implementation
is one structured-output request, not an agent loop. It writes the screen content
and narration together. It does not decide which tools to call or whether to keep
trying. The maintained application code owns that control flow.

| Component         | Count                           | Responsibility                                                                    | Can call a language model?                                                          |
| ----------------- | ------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Content generator | 1 adapter/role                  | Convert selected context into all screens and narration in one response           | Yes, for content generation only                                                    |
| API job runner    | 1 runner inside the API process | Claim a saved job, run the next missing stage, persist results and enforce limits | Through the content adapter only when content is missing and its attempt is allowed |
| Speech adapter    | 1 adapter inside the API        | Request audio for saved narration text                                            | No content-model calls; it calls the speech synthesis provider                      |
| Renderer service  | 1 Docker service                | Animate saved content in fixed templates, render clips and combine clips          | No                                                                                  |
| PostgreSQL        | 1 existing database             | Persist state, screen data, usage and artifacts                                   | No                                                                                  |

There are no planner, reviewer, coding, repair, supervisor or per-screen agents.
Three to six screens do not create three to six agents. The same runner iterates
over saved screens. Start with one active lesson and one renderer operation at a
time; the runner is not an additional deployment or an Agents SDK session.

### 2.2. Calls per successful lesson

For `N` screens, with no failures and no saved artifacts to reuse:

| Operation                           | Normal count                                           |
| ----------------------------------- | ------------------------------------------------------ |
| Content-model request               | 1 for the whole lesson                                 |
| Input-token preflight               | 1 for the immutable content request; reused on retries |
| Speech requests                     | N, one per screen                                      |
| Clip renders                        | N                                                      |
| Final combination                   | 1                                                      |
| AI review or layout-repair requests | 0                                                      |

A five-screen lesson therefore uses **one content-model request plus five speech
requests**, not one provider request total. Speech, rendering and storage have
their own costs; the token allowance in section 6 covers content generation.
Transport retries are exceptions within the persisted limits, not additional
agent turns. Resuming a media-only failure adds zero content-model calls.

### 2.3. Recovery ownership

```text
Process restarts or teacher chooses Continue
                    |
                    v
API runner reads PostgreSQL and claims the job
                    |
                    v
Saved screen JSON exists?
   |
   +-- No --> Check remaining content allowance
   |          --> Generate only if allowed; otherwise show stopped state
   |
   +-- Yes --> Reuse it; no content-model request
                    |
                    v
For each screen, read saved artifact references
   |
   +-- Audio missing --> Use remaining speech allowance, or saved text-only mode
   +-- Clip missing  --> Animate saved content + audio --> render and save
   +-- All present   --> Skip this screen
                    |
                    v
After all clips exist: is the final MP4 missing?
   +-- Yes --> Combine existing clips --> save --> Ready
   +-- No  --> Return the saved completed video
```

Every branch still checks cancellation, revision, lease and remaining attempts.
No renderer failure can route back to content generation when screen JSON exists.
The renderer neither owns recovery decisions nor asks an agent to fix its output.
Persist a screen's text-only presentation mode once speech is exhausted; resume
then skips speech for that screen until an explicit Add missing narration action.

## 3. Screen contract and visual behavior

Add `src/contracts/LessonVideos.ts` with strict schemas and named domain values.
The model-facing schema is a subset of the persisted contract; the server owns IDs,
versions, status, source snapshots, usage and artifact references.

Each screen contains:

- A layout: `explanation`, `example` or `comparison`.
- A title and bounded content appropriate to that layout.
- Narration text and a short takeaway.
- Optional IDs of selected source passages for the teacher to inspect.

Layouts have typed fields, not an unrestricted tree of elements. An explanation
has up to three short points; an example has one example or code snippet plus an
explanation; a comparison has two labelled columns. Source IDs must belong to the
saved selection, but do not require invented character offsets or an AI score.

Initial video format: 1280 × 720, 30 fps, 3–6 screens, targeting 60–120 seconds.
The target duration is guidance, not a completion promise. Actual audio duration
sets each clip's frame count, with a short fixed ending hold. A screen without
audio uses the maintained reading-duration policy described in section 6.6. Reject an oversized
lesson visibly rather than truncating narration or extending work indefinitely.

Render text and examples as live React elements inside the fixed Remotion
composition, not as a flattened PNG slide. Each template owns its typography,
spacing, content areas and animation. The model only supplies typed content and
selects a template; it does not generate React, CSS, coordinates or motion code.

```text
Fixed template                       Saved content data
  background, typography               title, points, example
  reserved content areas               narration audio
  reveal/highlight animation           measured audio duration
                 \                      /
                  +--------------------+
                  | Remotion composition|
                  +----------+---------+
                             |
                             v
                     Animated video clip
```

Start with title fades, point-by-point reveals, example emphasis and comparison
highlights. Content stays in reserved areas; emphasis changes opacity, colour or
small transforms without moving the surrounding layout. Keep revealed information
visible long enough to read. The template derives its timing from the frame and
saved audio duration. Do not add a timing agent or claim word-level speech alignment;
that is outside v1. Optional cuts/fades connect completed screens.

Use the same versioned template components and saved props for an inline preview
and rendered video. Final playback uses the saved MP4. A poster/thumbnail may be
produced for browsing, but it is not a checked intermediate stage or a prerequisite
for rendering. Failed thumbnail creation must not block a completed video.

All movement uses deterministic frame-based Remotion values. Bundle fonts and
assets; no runtime font downloads, random layout, CSS animations or model-supplied
asset URLs. Provide a text transcript alongside the video; word-synchronised
captions are deferred.

## 4. Template quality belongs in development

There is **no runtime layout checker**, geometry scoring, compact-layout retry,
visual approval gate or AI layout-repair request. A lesson does not fail because
a browser measurement claims text might overflow.

Maintain sensible field lengths and item counts in the structured data contract.
Templates provide predictable wrapping, stable content regions and readable font
sizes. These limits are input constraints, not a generated-layout review system.
Do not hide excess text with clipping or silently remove educational content.

Before shipping a template, test it with maximum supported content, long Vietnamese
text and code examples. Review representative rendered frames and animations in
development. If a visual defect slips through, fix the shared template and rerender
using saved content. Teachers can also shorten or edit content after viewing it.
Do not route visual defects into a paid model repair loop.

## 5. Persistence and resume

Use new versioned Prisma models; do not reinterpret the retired Guided Lesson
aggregate documents. Existing tables and applied migrations remain untouched.

| Proposed model         | Owns                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LessonVideo`          | Owner/class, selected-source snapshot, current revision, job status/stage, lease, attempt counters, token usage, last error and last completed video reference. |
| `LessonVideoScreen`    | Lesson/revision/position, stable ID, screen data, template ID and saved audio/clip references with their input hashes.                                          |
| `LessonVideoArtifact`  | Immutable artifact kind, lesson/revision, MIME type, digest, byte length, creation time and media bytes.                                                        |
| `LessonVideoAllowance` | Teacher/deployment daily allowances, reported usage and outstanding reservations; retained independently of lesson deletion.                                    |

Keeping small beta media in PostgreSQL follows the existing material-file storage
pattern and avoids introducing object storage now. It increases database size,
backup traffic and serving load; it is an explicit beta limit, not the intended
storage design for a large video library. Start with 10 MiB per clip and 64 MiB
per final MP4, bounded per-lesson and per-teacher storage. Migrate large artifacts
to object storage behind the same port if measured volume warrants it.

The API runner reads durable rows, not an in-memory task queue. Begin with one API
replica, one active lesson job and one renderer operation at a time. Claim work
atomically using a lease and monotonically increasing claim version. Every result
write must match both the current claim and lesson revision. No database transaction
stays open across a provider or render call.

Save an artifact and its screen reference in one transaction. A completed reference
is the checkpoint; a temporary file is not. On restart, reclaim expired work and
resume at the first missing artifact. Old workers cannot attach late results.

| Interruption                           | Resume behavior                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Desktop navigation or window closure   | Backend continues; reopening reads persisted status.                                                                         |
| API exits before model output is saved | The in-flight output may be lost; a bounded content attempt may be needed again. Do not claim exactly-once provider billing. |
| API exits after screen JSON is saved   | Reuse the saved JSON; never regenerate it implicitly.                                                                        |
| Speech request fails                   | Reuse other screens' saved audio; retry only the missing audio.                                                              |
| Renderer disconnects or crashes        | Recreate only the unfinished clip from saved screen data, template and audio.                                                |
| Final combination fails                | Reuse all saved clips and rerun combination.                                                                                 |
| User edits a screen                    | New revision; reuse unchanged artifacts by input hash, invalidate only changed dependencies.                                 |

Reuse hashes include screen/narration data, speech settings and the renderer build
ID as applicable. A changed narration invalidates audio and video; changed visual
content invalidates its video but preserves unchanged audio. Updating a template
invalidates affected clips without regenerating content or unchanged narration. Keep a previous finished video available
and label its revision clearly while a newer revision is running or failed.

No frame-level checkpointing in v1: a crash may repeat one short clip, not the whole
lesson. Cancellation persists first and fences late completions; already incurred
provider costs cannot be undone. Delete cancels active work and removes only the
owner's new-feature records/artifacts after ownership checks.

### 5.1. Concrete recovery from the failures we encountered

The old incidents motivate these requirements; this spec does not establish a new
root cause for historical connection errors. The replacement must make every
failure identify its operation and last durable checkpoint.

| Failure                                                                  | Automatic behavior                                                                                                                                                                             | What the teacher sees / next action                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Model connection breaks, including `EPIPE` or `TLS_ALERT_BAD_RECORD_MAC` | Retry the same bounded request only for a classified transient connection failure, within the SDK allowance/deadline. Do not disable TLS verification. Save a successful response immediately. | If exhausted: **Content generation stopped**; explain that output was not saved and another content attempt may cost money.        |
| Response was generated but lost before its database commit               | Keep any saved data and record uncertain provider usage. Do not pretend the missing response can be reconstructed from memory or a request ID.                                                 | **Retry content generation** is a distinct paid action; it is not silently included in a media resume.                             |
| A speech request fails                                                   | Retry only that screen's saved narration within its allowance, then render it with visible narration text. Keep other audio; persist which screens lack audio.                                 | **Finishing without narration for screen 3**; offer Add missing narration later within its allowance.                              |
| Renderer connection drops or process exits                               | Retry only the unfinished media operation within its allowance, using persisted input. A repeated response is accepted only for the current revision/claim.                                    | **3 of 5 clips saved; retrying clip 4** or an actionable stopped state.                                                            |
| Renderer reports out-of-memory                                           | Stop automatic retries for a confirmed resource failure; retain all completed media. An unidentified disconnect is not proof of OOM.                                                           | **Rendering needs more capacity**; retry after the operator fixes capacity, with an explicit bounded media allowance if exhausted. |
| API process restarts                                                     | Startup checks unfinished jobs and expired leases, then claims eligible work. Do not automatically restart failed, cancelled or exhausted jobs.                                                | **Resuming from saved work**, with the actual stage and screen count.                                                              |
| Database save fails or its result is uncertain                           | Do not advance to the next stage. Read the deterministic artifact key when the database returns before repeating external work. Pause work while checkpoints cannot be persisted.              | **Could not save progress**. Saved earlier stages remain; unsaved output might need repeating.                                     |
| Final MP4 combination fails                                              | Reuse every saved clip and retry only combination.                                                                                                                                             | **All 5 clips saved; finishing video**. No model or speech request.                                                                |
| A new revision fails while an older video exists                         | Keep the old completed artifact and its version label.                                                                                                                                         | **Version 2 stopped. Showing completed version 1.**                                                                                |

Network retries can recover a temporary interruption; they do not fix a persistent
TLS, proxy, provider or network problem. After the allowance is exhausted, stop and
retain safe diagnostics for investigation rather than multiplying paid requests.

### 5.2. Example: clip 4 fails in a five-screen lesson

```text
PostgreSQL before the failure:
  Lesson content: saved for all 5 screens
  Screen 1: data saved  | audio saved | clip saved
  Screen 2: data saved  | audio saved | clip saved
  Screen 3: data saved  | audio saved | clip saved
  Screen 4: data saved  | audio saved | clip missing <-- connection broke
  Screen 5: pending

Automatic retry, or Continue after a recoverable stop:
  Claim current job/revision and check remaining allowance
       |
       +--> Skip screens 1, 2 and 3
       +--> Load saved content + template + audio for screen 4
       +--> Render clip 4 and commit it
       +--> Finish screen 5, saving each result
       +--> Combine saved clips 1-5 and commit final MP4
       +--> Mark current revision Ready

Additional content-model requests: 0
Repeated audio for screens 1-4:    0
Repeated completed clips:         0
```

The unfinished clip may restart from its first frame. An output that existed only
inside the renderer before the crash is not a durable checkpoint. If the final
save's acknowledgement was lost but the transaction committed, find and reuse it
by its artifact key instead of rendering again.

### 5.3. What prevents another endless run?

1. Persist the stage, revision, lease/claim version, attempt allowance and overall
   deadline before issuing external work. A heartbeat renews a live lease; a stale
   claim cannot write results after a new worker takes over.
2. On success, commit the artifact and stage reference together. Each artifact key
   binds the lesson, revision, screen, kind and relevant input hash.
3. On failure, classify it as transient, requires an edit, requires an operator,
   cancelled or exhausted. Only transient failures retry automatically.
4. A restart, refresh or Continue click never grants new model tokens or attempts.
   Where a library's in-flight attempt count cannot be recovered after a crash,
   conservatively retain its reserved allowance rather than assuming no calls ran.
5. A media allowance reset is an explicit bounded **Retry rendering** action and
   reuses saved content. It must never authorize a fresh content-model request.
   A new paid content attempt requires the separately labelled content action.
6. Repeated Continue clicks cannot start competing jobs: atomically return the
   existing active job or transition one eligible stopped job back to queued.

**Continue** is enabled only if there is resumable saved work, a recoverable failed
stage (or an explicit cancellation resume), no active claim, and remaining
allowance/deadline. Otherwise explain the
required action instead of showing a spinner or a button that restarts everything.
On connectivity loss, the desktop shows the last known state with an offline
indicator; it does not invent a failed backend state or submit another create call.

Recovery acceptance tests must interrupt the API and renderer before and after
artifact commits, simulate a lost commit acknowledgement, and click Continue twice.
Verify saved output reuse, stale-write rejection, bounded attempts and zero content
calls during media recovery. A real database/volume loss is outside process-restart
recovery and requires an independently tested backup/restore procedure.

## 6. Retry and cost boundaries

Use library retries rather than another handwritten backoff framework:

- OpenAI requests: the installed SDK owns transient transport retries, with at
  most two retries and an overall deadline. Do not wrap it in another retry loop.
- Renderer HTTP: use `gaxios` for bounded transient retries. Only retry deterministic
  operations with the same persisted input. A lost response can duplicate compute;
  revision fencing prevents duplicate accepted artifacts, not duplicate execution.
- No retries for authentication errors or invalid input.
- Persist job-level attempt counts before work. Repeated restarts or clicking
  **Continue** must not reset a failed stage's total allowance. The three-attempt media limit includes transport retries;
  it must not become three runner attempts multiplied by three HTTP attempts.

Proposed initial configuration, to validate with a small fixture benchmark:

| Limit                      | Initial proposal                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Model context              | At most 8,000 source-text tokens; at most 12,000 provider-counted total input tokens including prompt/schema           |
| Model output               | At most 6,000 tokens for the complete lesson                                                                           |
| Content requests           | One logical request, at most three transport attempts per revision                                                     |
| Reserved content allowance | Up to 36,000 input / 18,000 output tokens including all retry attempts                                                 |
| Model deadline             | Three minutes total, including retries                                                                                 |
| Media stage attempts       | At most three attempts per screen/stage, persisted across recovery                                                     |
| Render concurrency         | One job and one render process initially                                                                               |
| Whole-job wall time        | Ten minutes before a visible stopped state; further media work requires an explicit bounded retry window and allowance |

Reserve the worst-case content allowance before a logical SDK request; record
reported usage separately from estimates and uncertain transport outcomes. Never
present a missing provider usage receipt as zero cost. The worked estimates below
use published standard rates; they are not a guaranteed full-video invoice. Confirm
the candidate model with fixtures rather than adding a planner/reviewer ensemble.

The input snapshot includes only the chosen material, goal, audience and language.
Reuse the bounded material selection utilities where suitable. Do not send full
material collections, generated code, repeated history or screenshots to the model.

Put these settings in `src/server/config/LessonVideoConfig.ts`, exported by
`Index.ts`. Only credentials and deployment addresses belong in `Env.ts`.

### 6.1. Explain the old 6M-token number before comparing it

A usage total is a sum across calls and possibly revisions, not necessarily the
size of one prompt. Repeated generation/repair calls can resend source context,
code and conversation history. For illustration, 60 requests averaging 100,000
input tokens sum to 6 million input tokens. This is arithmetic, not a verified
reconstruction of the old run.

Do not derive the old bill from the displayed total alone. An audit needs per-call
model IDs, input/output split, cached input, timestamps, run/revision IDs and known
or uncertain retry outcomes. The new UI must distinguish the current revision's
usage from lifetime lesson usage. Reusing a lesson must not make an old cumulative
counter look like the current render's token consumption.

The rebuilt renderer does not make content-model calls. It cannot accumulate model
tokens while combining clips or fixing a connection. Only the bounded content
adapter can spend content tokens; speech is accounted for separately.

### 6.2. Estimate before generation, settle after the response

1. Build the exact immutable request payload: selected source text, teacher prompt,
   instructions and structured-output schema. Include protocol/schema overhead,
   not just the visible class material.
2. Use the existing local tokenizer to trim the source selection, then use the
   provider's input-token counting endpoint once for that request/model. Reuse its
   result for unchanged retries. This is a preflight request, not another content
   generation call or an AI planning step. If counting is unavailable, stop before
   paid generation rather than bypassing admission.
3. Admit only requests at or below 12,000 input tokens. Set
   `max_output_tokens = 6000` on the generation request. That output limit includes
   reasoning tokens; visible JSON length is not the full billable output.
4. Budget retries as potentially billable even when a connection fails. Reserve
   all three possible attempts before the logical SDK call. A restart preserves
   reservations when the actual number of provider attempts is uncertain.
5. On response, persist input, cached input, output, reasoning-token detail,
   model ID, request ID and the price-table version with the result. Calculate
   reported cost from provider usage, not characters or a client stopwatch.

OpenAI documents both input-token preflight and output accounting, including
non-visible tokens, in [Counting tokens](https://developers.openai.com/api/docs/guides/token-counting).
The installed client already exposes `responses.inputTokens.count`; existing
material preparation is a repository example of the boundary, not a pipeline to
copy wholesale.

```text
I = provider-counted input tokens
O = configured maximum output tokens
A = maximum attempts, including the first request

Reserve for content = A * (I * input_rate + O * output_rate) / 1,000,000

Reported content cost =
  ((input_tokens - cached_tokens) * input_rate
   + cached_tokens * cached_input_rate
   + output_tokens * output_rate) / 1,000,000
```

This formula uses standard text pricing for the chosen model/tier. Record any
applicable regional or tier adjustments. Reasoning tokens are already included
in output tokens; cached tokens are a subset of input tokens. Do not add either
again. Reserve with uncached rates; cache savings are a benefit, not permission to
send a larger context. Missing usage leaves an uncertain reservation until billing
reconciliation; it does not free the budget automatically.

### 6.3. Worked content-cost examples

USD, standard text rates checked October 12, 2026; no cache discounts, regional
uplifts, special tiers, speech, hosting or storage included. These are scenarios,
not measurements of the new implementation.

| Content model | Input / 1M | Output / 1M | Example: 6K input + 2K output | One attempt at 12K input + 6K output | Three attempts at those limits |
| ------------- | ---------- | ----------- | ----------------------------- | ------------------------------------ | ------------------------------ |
| GPT-5.4 mini  | $0.75      | $4.50       | $0.0135                       | $0.036                               | $0.108                         |
| GPT-5.4       | $2.50      | $15.00      | $0.045                        | $0.12                                | $0.36                          |

Sources: [GPT-5.4 mini pricing](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
and [GPT-5.4 pricing](https://developers.openai.com/api/docs/models/gpt-5.4).

Start evaluation with GPT-5.4 mini for this constrained task. Choose a supported
low/no-reasoning setting through a small Vietnamese/English fixture evaluation.
Do not silently escalate to the larger model on failure. Changing models changes
the price reservation and must still fit the configured budget.

The expected 6K/2K example is about 1.4 cents of content generation on mini. The
18K-token single-attempt ceiling is larger to leave room for schema, Vietnamese
text and output variability. Across three full attempts, the revision ceiling is
36K input plus 18K output: **54K content tokens**, not an open-ended repair session.
A broken connection may consume that allowance without returning a usable result;
a low bound controls the loss but does not guarantee success.

### 6.4. Hard admission, including repeated Regenerate clicks

Proposed beta defaults, configurable in the owning backend config:

| Boundary                     | Limit / behavior                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| One content revision         | 3 total attempts, 36K input and 18K output maximum; reserve at most USD 0.15 in standard content-model charges                             |
| Teacher content allowance    | USD 1/day for reported usage plus outstanding/uncertain reservations                                                                       |
| Deployment content allowance | USD 10/day for reported usage plus outstanding/uncertain reservations                                                                      |
| Narration text               | At most 3,000 characters per lesson and 1,000 per screen; at most 3 speech attempts per screen                                             |
| Speech allowance             | Reserve retried text too: at most 9,000 submitted narration characters per revision, 30,000 per teacher/day and 100,000 per deployment/day |
| Rendering                    | One operation at a time, bounded operation deadlines/attempts and the persisted whole-job deadline                                         |

The USD 0.15 default admits the mini scenario but not three full GPT-5.4 attempts;
reject a configuration/request whose worst-case reservation does not fit. Do not
send the first request and hope later retries stay cheap. Dollar allowances use
integer micro-USD and a maintained model/tier rate table, not floating-point sums.
If no reviewed rate is available, generation is unavailable until configured.

Persist allowances in a small `LessonVideoAllowance` Prisma record keyed by teacher
or deployment and UTC day, following the existing allowance-adapter pattern. Before
network dispatch, reserve the revision and both daily allowances atomically. Store
the reservation identity with the job so duplicate creates, workers, refreshes,
restarts and retries cannot reserve/spend independently. Daily windows use persisted
server timestamps, not the teacher's device clock.

A new content revision reserves again against the same teacher/deployment daily
limits. An explicit Regenerate click does not override them. Deletion does not
erase usage records. A running reservation remains charged to its original window
across midnight; do not replenish it by restarting. Reconciliation can release only
proven unused allowance. An administrator can explicitly change the policy later;
the job itself cannot increase limits.

If a limit is reached, stop issuing requests against that exhausted allowance.
Keep independent, already reserved stages eligible: a content limit must not stop
rendering saved content. Use the delivery behavior in section 6.6. Show **Budget
reached - progress saved** only when the job cannot progress further within its
remaining allowances; keep saved screens/transcript or a completed video accessible.
Provider-side project limits/alerts are an additional control; the application must
enforce its own checks before dispatch regardless of billing-dashboard latency.

### 6.5. Speech, rendering and the estimate shown to the teacher

```text
Estimated video cost
  Content generation: counted input + predicted output at the chosen model rate
  Narration:           estimated speech usage from the selected voice/model
  Rendering/storage:   measured infrastructure usage and shared service overhead

Details
  Reported usage:      provider receipts already received
  Reserved:            allowance held for pending requests/retries
  Usage uncertain:     disconnected calls awaiting reconciliation
```

Content generation and speech have different billing units. The speech adapter
must define its own estimate and reconciliation using the selected provider's
published rates and available receipts. A text-character limit bounds requests;
it is not an exact audio-token price or a guaranteed speech dollar maximum.
Do not reuse the text-model output rate for audio. Select a currently supported
speech model during implementation rather than assuming an old adapter's model
remains suitable.

Bounded renderer runtime controls per-job resource use, but a Railway service can
also incur idle/shared hosting and database/storage costs. Measure render duration
and resource consumption in the fixture benchmark; show those costs separately
from token spend. Do not advertise USD 0.0135 as the entire video price.

Before Create, show a compact estimate with a Details expansion for the content
reservation and separate speech/hosting estimates. If those latter estimates are
not calibrated yet, label them unavailable instead of presenting an invented total.
After generation, show reported usage and any uncertainty. Do not show token counts
in the primary progress banner.

Cost acceptance tests must simulate repeated transient failures, duplicate Create
requests, restarts, simultaneous admissions, Regenerate, deletion and midnight.
Assert that content dispatch cannot exceed the persisted attempt/token/dollar
allowance, and that media recovery makes zero content calls. Benchmark the normal
input/output distribution and successful-video rate before adjusting these defaults.

### 6.6. Deliver useful work when a stage cannot finish

A spending limit bounds loss; it does not make an unavailable provider succeed.
The delivery strategy is to save a complete, small lesson first, then add media.
There is no optional model polishing, generated-code repair or review phase that
can consume the completion allowance. A successful content response ends all
content-model work for that revision.

At admission, reserve the bounded content allowance and the configured speech
character allowance, and check renderer readiness. Assign a separate bounded media
attempt/runtime allowance. Hold these for the admitted job; later jobs cannot use
its speech reservation. Content retries cannot borrow speech allowance or media
attempts. Readiness is a point-in-time check, not a guarantee against later failure.
Reject a job that cannot be admitted before sending its content request; preserve
the teacher's prompt and material selection for later.

```text
Complete screen data saved
         |
         +--> View screens + read/download transcript immediately
         |
         +--> Speech succeeds --> Render with narration --> MP4
         |
         +--> Speech unavailable/exhausted
                    --> Render with visible narration text --> MP4 with notice

Renderer unavailable/exhausted --> Saved screens + transcript remain usable
No usable content response     --> Keep request; explain no lesson was generated
```

Use the same fixed templates for the no-audio path. Each template includes a
maintained narration-text area with deterministic pagination, so the full saved
narration remains readable without clipping. Derive page duration from a configured
reading-time policy with minimum holds, tested in English and Vietnamese; persist
that duration. Audio is optional in render props. This requires no model call,
layout checker, new agent or alternate rendering service. The 60–120-second target
may be exceeded for readable text; expose the actual duration.

If some speech succeeds, preserve it and show narration text on the screens lacking
audio. Persist missing-audio screen IDs and the presentation mode in artifact input
hashes. **Video ready — narration unavailable for 2 screens** identifies the real
result. Offer **Add missing narration** later, subject to remaining or explicitly
renewed speech/media allowances; regenerate only affected clips and combine again.
Do not launch that upgrade automatically or erase a usable earlier video.

If rendering stops, expose **Lesson content ready — video not finished**, with
inline screens, a downloadable transcript and an eligible Continue rendering action.
This is not a completed MP4: keep the job stopped, and derive available actions
from saved artifacts. Completed clips may remain available as individual clips,
but an incomplete set must never be labelled the complete lesson video.

If all content attempts fail before usable structured output is saved, there is
no generated lesson to render. Preserve the request and any previous completed
revision. Allow the teacher to enter screen content manually using the same editor,
or retry content when its allowance permits. Do not silently turn arbitrary source
excerpts into a supposedly generated explanation or accept malformed partial JSON.
No design can guarantee a new AI lesson and MP4 through simultaneous provider,
database or renderer outages under a fixed spending limit.

Acceptance: content-budget exhaustion after a successful save must not block media;
speech exhaustion produces a correctly labelled video when rendering succeeds;
render exhaustion leaves readable screens/transcript; admission failure makes zero
content calls; content failure never reports a finished lesson. All fallback work
uses the existing deadlines and allowances and cannot create a fresh retry loop.

## 7. Runtime boundaries, local development and Railway

```text
Teacher's native Electron app
             |
             | Authenticated HTTP through the desktop bridge
             v
+----------------------------------------------------------+
| API process                                              |
|                                                          |
| Lesson routes --> ONE durable job runner                  |
|                         |                                |
|                         +--> Content generator adapter --+--> Model API
|                         +--> Speech adapter -------------+--> Speech API
|                         +--> Prisma persistence ---------+--> PostgreSQL
|                         |                                |    checkpoints,
|                         +--> Renderer HTTP client        |    screens, media
+--------------------------------------|-------------------+
                                       |
                                       | Authenticated internal HTTP
                                       v
                      +------------------------------------+
                      | ONE Docker renderer service        |
                      |                                    |
                      | Fixed templates + content animation|
                      | Remotion clip rendering            |
                      | Final clip combination             |
                      |                                    |
                      | Temporary files; no model calls    |
                      +------------------------------------+
```

Locally, the API process runs natively and the renderer runs in Docker beside the
existing database container. On Railway, the API and renderer are separate services
using the same ownership boundaries. The shipped desktop app runs neither the
content generator nor the production renderer. Only the renderer is a new deployed service;
the API runner, adapters and templates are modules within the shown processes.

The renderer runs maintained code only. It receives validated data and bounded
media uploads from the API. It has no OpenAI key, database credentials, Docker
socket, arbitrary filesystem access API or ability to execute generated code.
Temporary job directories are cleaned up after completion and on startup.

Use a small authenticated internal HTTP interface for clip rendering and final
combination, plus health/version reads. Stream bounded
uploads/downloads where possible; never load all frames into API memory. Size limits
must also be enforced before buffering an individual database artifact. A full
renderer returns a retryable busy response rather than accepting an unbounded queue.
The API persists outputs; a renderer restart requires no state restoration.

Build the trusted Remotion bundle and include its browser/fonts in a versioned
renderer image. Do not install packages or bundle a new project per lesson.
Remotion accepts JSON input props for video rendering; pass saved content into
the shared, prebuilt template bundle.
[Video rendering](https://www.remotion.dev/docs/renderer/render-media),
[Docker setup](https://www.remotion.dev/docs/docker).

Local development:

1. Keep API and Electron native on the developer's machine.
2. Extend `compose.yaml` with the renderer alongside the existing PostgreSQL service.
3. Keep `doppler run -- pnpm dev` as a supported entry point. The development launcher
   starts/checks local containers, builds a missing renderer image, then starts API
   and desktop. Forward backend secrets only to the API, never Electron or renderer.
4. If Docker or renderer startup fails, show the exact prerequisite error. The rest
   of Tro can still start; lesson creation reports renderer unavailable.
5. Provide `pnpm dev:renderer` for renderer source watch/rebundle inside Docker and
   `pnpm build:renderer` for a production-equivalent image. API edits use native watch.
   Rebuild the image when browser, dependencies or fonts change.

Railway:

- Retain the existing API and PostgreSQL services. Add one persistent renderer
  service built from a dedicated Dockerfile in the same repository.
- Use Railway private networking; no public renderer domain. Configure the internal
  service address and service authentication secret through deployment environment
  settings. The API still authenticates and authorizes every teacher operation.
- PostgreSQL remains the durable store; the renderer needs no persistent volume.
  Container-local files are disposable, including during deploys.
- Start with one renderer replica and a measured resource allocation. Run a long-text
  and six-screen load fixture before choosing CPU, memory and timeouts. On confirmed OOM, stop
  automatic retries and expose the failed stage rather than requesting new content.
- Ship API and renderer with a compatible protocol version; the API checks renderer
  readiness/version before starting media work. Keep login and general API health
  independent of renderer readiness.

Railway supports Dockerfile-based services and private networking. Its persistent
volumes are relevant if later moving artifacts out of the database; a container
filesystem is not durable storage.
[Services](https://docs.railway.com/services),
[private networking](https://docs.railway.com/networking/private-networking),
[volumes](https://docs.railway.com/volumes).

## 8. Simple creation form, visible status and diagnostics

### 8.1. What the teacher supplies

The entry point is one page with one primary action. Keep the selected class when
opening it from a classroom. The teacher describes the desired video in ordinary
language and chooses the class materials it should use.

```text
Create lesson video

Class                  [ Python - Grade 8             v ]

What do you want to explain?
+-------------------------------------------------------+
| Explain Boolean values to beginners. Use examples     |
| from Lesson 4 and show why -5 < -4 is true.            |
+-------------------------------------------------------+

Class materials
[x] Lesson 4 - Logical and comparison operators
[ ] Practice worksheet

Video language          [ Vietnamese                  v ]
Length                  About 1-2 minutes

[ Create video ]
```

| Input           | Behavior                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class           | Required; default to the current class. Only show classes the teacher can access and create content for.                                                                                      |
| Teacher prompt  | Required plain text: what to explain, intended students, examples or tone. Trim whitespace; initial maximum 2,000 characters. Use examples as placeholder text, not a forced prompt template. |
| Class materials | Select at least one existing, prepared material from that class. Show names and optional section/page selection. Do not silently select every class document.                                 |
| Language        | Default to the app language; allow Vietnamese or English.                                                                                                                                     |
| Length          | Use the 60–120-second target automatically in v1. No scene-count, model, renderer or retry settings in the creation form.                                                                     |

A separate audience field is unnecessary initially: use existing class context and
let the teacher describe additional needs in the prompt. Creation generates the
title, screen content, layout choices and narration together. The teacher should
not have to write a script, choose every layout or approve intermediate steps.

Unavailable or unprepared material is identified before creation; link back to
Materials to prepare it. Do not silently launch a second material-preparation
model workflow from the video button. Prompt-only general-knowledge videos are
outside this first release; explain the material requirement beside the selector.

### 8.2. How input reaches generation

```text
Teacher prompt + selected class/material IDs + language
                           |
                           v
API verifies teacher access and selected material membership
                           |
                           v
Read selected prepared content; choose a bounded source packet
                           |
                           v
Save immutable creation input + material revision references
                           |
                           v
ONE content request:
  - teacher goal and preferences
  - class/audience context
  - selected source passages
  - output language and target length
  - fixed screen schema and layout limits
                           |
                           v
Saved screen JSON --> audio --> fixed-template animation --> video
```

The desktop sends IDs, the prompt and language; the API resolves the actual material
content. Never trust a client-supplied source document or class ownership claim.
Keep teacher instructions separate from source passages in the model request.
Material text is reference data and cannot change system rules or request tools.

Use deterministic selection from the existing material context utilities, not
another planning agent. Record selected material revisions and actual passages in
the snapshot. If required selected content cannot fit the source allowance, ask
the teacher to narrow the selection before a paid call. Resume uses this same
snapshot even if class material changes later; using newer material is an explicit
new content revision.

The create endpoint accepts a client-generated request ID. Persist its association
with the job under the teacher's identity and request payload hash. A repeated click
or lost response returns that same job; reusing the ID with different input is a
conflict. Disable the button while submitting, but enforce deduplication on the
backend as well. This prevents duplicate application jobs; it does not promise
exactly-once billing for an interrupted provider request.

### 8.3. Status is part of the main interface

Show status directly below the video title and on its library card, not only in
logs or a details panel. Use a small persisted status set (`queued`, `running`,
`ready`, `stopped`, `cancelled`) plus the current stage and saved screen counts.
Retries are stage details, not a second conflicting lesson status.

| Visible status                            | Meaning                                                     | Main action                                                           |
| ----------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Waiting to start                          | Job saved; waiting for runner capacity                      | Cancel                                                                |
| Writing your lesson                       | The bounded content request is running                      | Cancel                                                                |
| Creating narration 2/5                    | Saving audio; 2 screens have audio                          | Cancel                                                                |
| Rendering video 3/5                       | Saving clips; 3 clips are complete                          | Cancel                                                                |
| Finishing video                           | Combining saved clips and saving the final MP4              | Cancel                                                                |
| Retrying screen 4 - attempt 2/3           | A permitted transient retry is running                      | Cancel                                                                |
| Content generation stopped                | No screen output was saved; provider work may have occurred | Retry content generation with a cost explanation                      |
| Stopped - progress saved                  | Recoverable stage failed; saved content is intact           | Continue, only when eligible                                          |
| Rendering needs attention                 | Capacity/configuration failure or exhausted allowance       | Show the required fix or explicit bounded retry action                |
| Budget reached - progress saved           | A persisted spending or attempt allowance is exhausted      | Show limit and reset time; allow eligible media-only continuation     |
| Lesson content ready - video not finished | Screens/transcript saved; MP4 incomplete                    | View screens / Download transcript / Continue rendering when eligible |
| Video ready - some narration unavailable  | Complete MP4, with text on screens missing audio            | Play / Download / Add missing narration when eligible                 |
| Video ready                               | Final MP4 is committed for the displayed revision           | Play / Download                                                       |
| Cancelled - draft saved                   | Job cancelled; saved work remains                           | Continue, via an explicit resume action if eligible                   |

These labels are localized in English and Vietnamese. Display counts of committed
artifacts, not guessed overall percentages or a made-up completion time. Because
screens run sequentially, a stage change can show a different saved count; the
label must always identify what that count measures. Keep the most recent safe
failure reason and time available in optional details.

```text
Boolean and comparisons                         Rendering video 3/5
+---------------------------------------------------------------+
| [spinner] Rendering screen 4                                  |
| 3 clips saved. You can leave this page; creation continues.    |
|                                                               |
| [ Cancel ]                                                    |
+---------------------------------------------------------------+

After a recoverable interruption:
+---------------------------------------------------------------+
| Creation stopped. 3 of 5 clips are saved.                     |
| Continue will reuse your saved screens, narration and clips.  |
|                                                               |
| [ Continue from saved work ]                                  |
+---------------------------------------------------------------+
```

Persist progress on stage changes, artifact commits and terminal outcomes. The UI
reads the same server status after navigation or restart. Poll only while work is
active, back off while disconnected, and stop polling when the page unmounts;
unmounting never cancels the backend job. An offline UI says **Connection lost -
showing last saved status** instead of turning the job into a failure. Announce
stage changes accessibly without reading every poll through an `aria-live` region.

A cancelled job never resumes automatically. An explicit Continue action can
atomically resume it only after its old claim has ended and its saved revision,
remaining budget and deadline permit it. Otherwise show the necessary bounded
retry action. This uses the same fencing rules as failure recovery.

### 8.4. Reviewing and editing the result

One creation action runs the whole path. No script approvals, scene approvals,
preview approvals or AI reviewer. Teacher review happens by watching/editing the
result and deciding to use it.

- Show saved screens and their downloadable transcript as soon as content is saved;
  switch to inline MP4 playback when it exists. Keep screen thumbnails and a simple
  text editor available. Label incomplete media and missing narration explicitly.
- Overlay play/pause, seek, volume and +/-5-second controls on the video. Reveal
  them on hover/focus and keep them reachable on touch and keyboard.
- **Regenerate content** creates a new content revision and clearly makes a new
  paid model request. **Render again** uses existing content.
- Editing the saved teacher prompt or material selection starts a new content
  revision when explicitly submitted. Editing one screen reuses unchanged work.
- Distinguish an exhausted content budget from a media retry allowance. A media
  retry must not send another content request.
- Keep a previous video visible when available: **Version 2 stopped. Showing
  completed version 1.** A failed revision never overwrites the finished version.
- Put token usage, request IDs and technical errors in optional details. The
  primary UI explains the current stage and what the teacher can do next.

### 8.5. Diagnostics

Log stage transitions and terminal failures with lesson/revision/screen IDs,
attempt, elapsed time, renderer build, provider request ID, reported token usage,
usage uncertainty and safe error codes. No source text, teacher prompt, narration,
credentials, image data or
hidden reasoning in ordinary logs. Do not log every poll or frame.

## 9. Code implementation plan

This is a file/ownership plan for new code, not a description of implemented files.
Use the existing modular monolith and constructor-injected ports. Keep one readable
stage runner; do not add a workflow engine, dependency-injection framework, generic
agent harness or separate package for every layer.

### 9.1. Follow the existing configuration pattern

The inspected examples are [MaterialConfig.ts](../src/server/config/MaterialConfig.ts),
[VoiceoverConfig.ts](../src/server/config/VoiceoverConfig.ts),
[config/Index.ts](../src/server/config/Index.ts) and
[StartApi.ts](../src/server/StartApi.ts). Follow their constant + schema + reader
pattern. Add **`src/server/config/LessonVideoConfig.ts`**, exported by the existing
**`src/server/config/Index.ts`**. Do not introduce a competing root `/config`
directory or put configuration beside each feature implementation.

| Config group   | Owns                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `content`      | Model choice, reasoning setting, input/output limits, maximum total attempts and request deadline.        |
| `speech`       | Supported model, voices per locale, text limits, maximum attempts and timeout.                            |
| `budget`       | Model/tier rates and rate version, integer micro-USD revision/daily caps and speech character allowances. |
| `render`       | Requested frame size/FPS, operation deadline, maximum attempts, concurrency and artifact-size policy.     |
| `jobs`         | Poll interval, lease/heartbeat intervals and whole-job deadline.                                          |
| `presentation` | Reading-time policy and minimum holds for screens without audio.                                          |

Export `LessonVideoConfig`, `LessonVideoSettings` derived from the schema, and
`readLessonVideoConfig`. Use `z.strictObject`, `as const` and `satisfies`; validate
cross-field invariants as well as individual values. For example, a configured
model's worst-case content reservation must fit the revision budget, heartbeat
must be shorter than lease duration, and runtime limits must respect the canonical
protocol's hard bounds. Reject invalid settings with a safe message, never a raw
configuration dump.

`StartApi.ts` reads settings once inside startup error handling and passes typed
subsets to their consumers. Application/domain code never imports the global config
singleton or reads environment variables. Tests supply small settings objects,
clocks and deterministic IDs. Snapshot the relevant settings/rate/template version
on job admission so a restart or config change cannot silently enlarge a running
job's allowance or change its artifact hashes. Current admission policy may block
new paid work; it must not rewrite recorded usage.

Keep API keys, database URLs, renderer addresses and authentication secrets in the
appropriate process `Env.ts` using the existing validated environment pattern.
The API reads `LESSON_RENDER_URL` and `LESSON_RENDER_SECRET`; deployment addresses
are not lesson policy snapshots.
The renderer has its own `Env.ts` for its listen address and authentication secret;
it receives validated render options in the request, never server config, model
keys or budget data. Shared protocol ceilings live in the owning contract;
template typography/spacing are implementation constants owned by the templates.
Do not duplicate a tunable setting across those locations. Container CPU/memory
allocation remains deployment configuration, not an application env flag.

### 9.2. Proposed files and responsibilities

```text
src/
  contracts/
    LessonVideos.ts                 Public commands, replies, screen schemas, statuses
    LessonRenderProtocol.ts         Private renderer request/result schemas and version
  server/
    config/LessonVideoConfig.ts      Reviewed policy + validation; exported by Index.ts
    features/lessonVideos/
      domain/LessonVideoRules.ts    Pure transition, reuse and continuation decisions
      application/
        LessonVideoPorts.ts        Store, source, content, speech and renderer contracts
        LessonVideoService.ts      Authorized create/read/edit/cancel/resume/delete
        LessonVideoRunner.ts       One wake loop, claims, shutdown; no provider logic
        RunLessonVideoStage.ts     Explicit content/audio/clip/combine stage execution
        LessonVideoBudget.ts       Pure estimates and reservation calculations
      infrastructure/
        RegisterLessonVideoRoutes.ts  Authenticated HTTP boundary and error mapping
        ClassroomLessonSources.ts     Authorized material snapshot adapter
        OpenAiLessonContent.ts        One structured request + input count + receipts
        OpenAiLessonSpeech.ts         Saved text to bounded audio + duration
        HttpLessonRenderer.ts         Private HTTP + bounded gaxios transport retries
    persistence/
      PrismaLessonVideoStore.ts     Jobs, screens, artifacts AND atomic allowance writes
  lessonVideoPresentation/
    LessonComposition.tsx          Shared composition; receives only typed render props
    ExplanationScreen.tsx          Maintained explanation template
    ExampleScreen.tsx              Maintained example/code template
    ComparisonScreen.tsx           Maintained comparison template
    NarrationTiming.ts             Pure timing/pagination for no-audio presentation
  lessonRenderer/
    StartRenderer.ts               Process wiring, health/version, shutdown
    Env.ts                         Validated renderer-only deployment values
    RegisterRenderRoutes.ts        Authenticate, validate and bound internal requests
    RenderLessonClip.ts            Remotion invocation and temporary-file cleanup
    CombineLessonClips.ts          Bounded final combination, no content decisions
  desktop/
    main/lessonVideos/
      LessonVideoApiClient.ts      Authenticated API access; parse unknown replies
      LessonVideoMediaController.ts  Authorized media playback/download by artifact ID
    renderer/lessonVideos/
      LessonVideosPage.tsx         Library and creation form
      LessonVideoStudio.tsx        Saved screens, transcript, editor and media state
      LessonVideoPlayer.tsx        Inline MP4 controls; no job orchestration
      UseLessonVideo.ts            Typed commands, polling, stale-response protection
      LessonVideoLabels.ts         Pure status/action presentation
      LessonVideos.css            Feature styles using the existing desktop theme
```

These are responsibilities, not a mandatory file-count target. Keep small private
helpers in their owner; split only when a distinct responsibility makes code easier
to find. Share the browser-safe presentation module directly inside this repository;
do not make a new package. It may import React/Remotion and render contracts, but
never Prisma, Node APIs, server config, provider clients or authentication code.
The Docker entry point registers the shared composition; the desktop uses the same
components for content preview. Neither imports the other's process entry point.

Extend existing `DesktopBridge.ts`, `Preload.ts`, `Main.ts`, locale files and app
navigation with narrow validated lesson methods. Reuse desktop account gating and
trusted-sender checks, following `MaterialApiClient.ts` and existing material IPC.
Do not create a second login/session system. Give playback a main-owned media route
or protocol addressed by artifact ID; authorize each access and support bounded
range reads. Downloads use the native save dialog, never renderer-supplied paths
or arbitrary URLs. Revoke media access on logout/account change and release object
URLs/listeners on unmount.

### 9.3. Dependency direction and public boundaries

```text
React UI --> validated preload --> Electron main client --> HTTP routes
                                                              |
                                                         LessonVideoService
                                                              |
                                          application ports + pure domain rules
                                            ^       ^       ^       ^
                                          Prisma   source  OpenAI  HTTP renderer
                                                                    |
                                                          Fixed Remotion templates

StartApi --> validated config + concrete adapters --> service + one runner
```

Domain rules use framework-free types/constants and have no I/O. Application code
uses its own ports and explicit values, without Fastify, Prisma, OpenAI, gaxios,
Remotion or Electron imports. Adapters implement ports; only composition roots
construct concrete dependencies. Renderer unavailability disables lesson creation
with an actionable status; it must not block authentication or unrelated API routes.
Extend `CheckBoundaries.ts` for the new owners
and browser-safe presentation imports rather than weakening existing checks.

Use named `as const` values such as `LessonVideoStatus.RUNNING`,
`LessonVideoStage.CONTENT` and `LessonVideoFailure.BUDGET_REACHED`. Derive unions
and Zod enums from those values. Keep job status, available artifacts and missing
narration separate: a stopped job can have usable screens, while `ready` requires
a committed full MP4. Never derive a successful job solely from a media URL.

Public commands identify lesson/revision and, for creation, a request ID. They do
not accept owner IDs, budgets, arbitrary URLs or filesystem paths. The service
receives the signed-in user from the HTTP adapter and checks teacher/class access.
Validate unknown JSON at each external boundary; internal calls use schema-derived
types. Use explicit result variants for expected failures and reserve exceptions
for unexpected infrastructure failures.

Use a versioned `/api/v1/lesson-videos` command endpoint consistent with the current
material boundary, plus authenticated artifact/transcript GET routes. Define exact
command variants for create, read/list, edit screens, continue rendering, add missing
narration, regenerate content, cancel and delete. Regeneration remains a separate
paid action. Creation returns the durable queued job promptly, not a response held
open until video completion. Apply body limits before parsing and ownership checks
to every artifact read, including range requests.

### 9.4. How one job executes

1. `LessonVideoService.createLessonVideo` authorizes the class/material IDs through
   the source port, returns an existing matching request ID when present, builds
   the bounded immutable snapshot and counts input through the content port.
   Recheck the request ID in the admission transaction: create
   the job and reserve teacher/deployment allowances together. Wake the runner only
   after commit. Duplicate creates return the saved job without another paid call.
2. `LessonVideoRunner` claims one eligible job through the store and calls
   `runLessonVideoStage`. It owns wake/close and cancellation signals; the database
   owns state. A heartbeat renews only the active claim. Shutdown stops new claims,
   aborts bounded external work and leaves checkpoints for recovery.
3. The stage function reads current saved references and uses pure rules to choose
   exactly one missing operation: content, speech, clip or combination. Use a clear
   switch with small stage functions, not a configurable graph. Reserve/record the
   attempt before dispatch; invoke one port outside the transaction; commit its
   result only if revision and claim version still match.
4. On content success, save all schema-valid screens plus narration together and
   expose them immediately. On media success, save artifact bytes, input hash,
   receipt and screen reference in one transaction. Save the final MP4 reference
   and `ready` transition together. A lost acknowledgement is reconciled by the
   deterministic artifact key before another external operation.
5. On failure, map the adapter's safe error classification to retry, text-only
   speech fallback or stopped state. Respect existing reservations/deadlines across
   restarts. The content SDK owns transport retries inside its pre-reserved ceiling;
   gaxios owns renderer transport retries inside the media ceiling. The runner must
   not multiply either allowance with another retry loop.
6. The UI polls the saved job while active, keyed by account/lesson/revision. Ignore
   stale responses after edits or navigation. Derive actions from the typed reply;
   unmounting aborts polling, never the backend job. Only the explicit Cancel command
   cancels generation. On screen edits, fence active work and reuse unchanged
   artifacts by hash in the new revision.

Store methods should express business transactions: `createLessonWithReservation`,
`claimNextLesson`, `reserveStageAttempt`, `saveGeneratedScreens`,
`saveScreenArtifact`, `completeLessonVideo` and `stopLessonVideo`. Method input
contracts include the expected revision/claim where relevant. Avoid exposing a
Prisma client or generic `update(data)` method to the application. Keep reservations
and lesson writes behind the same persistence adapter/transaction client; a separate
allowance client must not turn atomic admission into two independent commits.

Reuse the existing material-selection functions only behind classroom authorization;
`ReadMaterialSources.ts` explicitly requires this. Use the new feature's store for
new lesson data. Preserve all retired models/migrations; add reviewed migrations
with indexes for eligible-job claims and unique request/artifact keys. The allowance
record retains usage after lesson deletion and is not cascade-deleted with media.

### 9.5. Clarity, comments and tests

Use action-first names (`saveGeneratedScreens`, `renderLessonClip`) and positive
predicates (`canContinueLesson`, `hasSavedContent`). Keep functions focused and
avoid helpers named `process`, `utils` or `manager`. Maintain strict TypeScript with
no `any`, unchecked assertions, suppression comments or duplicated contract types.
Keep non-component exports such as eligibility/status helpers in `.ts` files so
component modules remain compatible with Fast Refresh.

Write short JSDoc comments above important ports, services and transaction methods.
Describe ownership, units, side effects and guarantees. For example:

```ts
/** Saves clip bytes and the screen reference together, only for the active claim.
 * A stale worker returns a conflict and cannot replace the current revision. */
```

Use local block comments for why uncertain provider usage stays reserved, why
media recovery cannot call the content model, and why a no-audio clip includes its
presentation mode in the hash. Do not comment every obvious statement or promise
exactly-once provider billing. Public adapter documentation states bounds and
failure behavior; comments must stay consistent with tests.

Mirror production ownership under `test/`. Cover pure budget/transition decisions,
application stage selection with typed fake ports, boundary rejection and config
validation without credentials. Use disposable PostgreSQL for concurrent admission,
lease fencing, atomic artifact commits, midnight/deletion accounting and restart
recovery. Exercise actual Docker rendering with maximum-content EN/VI fixtures,
audio and no-audio modes. Desktop tests cover account changes, duplicate submits,
stale polling replies and accurate partial-output labels. Tests must assert zero
content calls on media recovery and demonstrate that cost limits survive restarts.

Implementation also updates package scripts, image build inputs, `compose.yaml`,
startup/close hooks and README commands. Add a conventional dedicated renderer
Dockerfile and PascalCase build/watch tooling only where existing scripts cannot be
extended clearly. Keep credentials out of image layers. Update `Architecture.md`
with implemented ownership when the feature ships; this proposed spec is not a
second runtime architecture source.

## 10. Implementation sequence and acceptance

| Phase                         | Deliverable                                                                                      | Acceptance evidence                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Prove rendering without AI | Three fixed animated templates, fixture audio, clip rendering and combination in Docker          | Maximum-content Vietnamese/code fixtures render legibly; animations are deterministic; final video has expected duration and audio.             |
| 2. Durable save/resume        | Contracts, new Prisma models, authenticated CRUD and one bounded API runner                      | Kill API/renderer between each checkpoint; saved screens/audio/clips survive and only missing work repeats.                                     |
| 3. Add one content request    | Bounded source snapshot, structured output, speech and persisted allowances                      | Normal generation uses one content request; renderer faults produce zero additional content calls; retries cannot exceed stored limits.         |
| 4. Teacher UI                 | Prompt/material creation form, visible status, library, edit/continue/delete and inline playback | Double-submit returns one job; navigation/reload restores stage and counts; stale results are labelled; keyboard controls work; no approval UI. |
| 5. Railway readiness          | Versioned renderer image, private service configuration and runbook                              | Matching local/production image succeeds on the fixture set; restart, timeout and OOM cases recover within limits.                              |

Acceptance also includes the degraded delivery cases in section 6.6: a usable
lesson remains accessible even when a media stage cannot finish.

Complete the scoped implementation edits before running each delivery's final
verification. Required checks: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm test:integration` and onboarding asset checks.
Keep ordinary checks independent of paid providers. Any paid generation benchmark
or Railway deployment requires its own explicit authorization.

A beta is ready when a teacher can create and replay a short lesson, interrupt and
resume rendering without another content request, edit one screen without losing
other completed work, and see an actionable error when a limit is reached.

## 11. Deliberate exclusions and remaining choices

Exclude generated code, model tools, runtime layout checks, AI reviewers, autonomous repair agents,
Temporal, Redis, dynamic Railway sandbox provisioning, arbitrary external assets,
word-level captions, quizzes, per-frame checkpoints and student publishing from
this first delivery.

Before implementation, confirm the proposed teacher-only scope and beta media
limits. Confirm the mini content-model candidate, speech model and renderer resource
allocation through the bounded fixture benchmark. These choices are configuration decisions; they should
not expand the architecture.

## 12. AI-generated explanatory animation

Status: implemented, October 12, 2026. A bounded writer supplies lesson content and
visual briefs. A bounded coder can supply SVG animation components for up to two
selected scenes. The worker interprets those components in QuickJS/WASM and passes
validated drawing data into the maintained Remotion composition. The supported API
is a small synchronous SVG subset, rather than arbitrary React/Remotion projects.
The [interactive prototype](../examples/previews/LessonAnimationPrototype.html)
simulates scene selection, playback and fallback locally; it makes no AI requests.

### 12.1. What is a template, and what does AI do?

The word "template" has two meanings here:

| Term                         | Meaning                                                                                                         | Owner                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Remotion starter application | Example application connecting a prompt, model-generated React code, preview and export. It uses AI.            | Remotion provides the reference project.                  |
| Tro presentation template    | Maintained video frame, fonts, narration, captions, timing, baseline layouts and reusable animation components. | Tro engineers write and version this code.                |
| Custom scene visual          | A small React/Remotion component explaining one scene inside that maintained frame.                             | AI generates it from the saved lesson and a visual brief. |

**AI does more than choose a template.** It writes lesson content, proposes what
visual would explain each scene, and writes custom animation code for the selected
scenes. Maintained application code chooses which proposals fit the allowance and
controls execution. Remotion renders the saved result; it does not make model calls.

```text
WE BUILD AND MAINTAIN                 AI GENERATES FOR EACH LESSON
---------------------                ----------------------------
Video frame and typography           Lesson text and narration
Reusable motion components           What visual explains each scene
Baseline lesson layouts              Code for selected custom visuals
Saving, budgets and recovery
Speech and rendering integration

                     Combined by the worker
                              |
                              v
                    Finished narrated video
```

For example, engineers provide text, arrows, circles, grouping, highlighting and
frame-based movement as optional reusable components. AI can combine those pieces
or draw additional SVG/React content inside the scene. This is not a mandatory
catalogue of subject-specific layouts or a fixed animation-action language.

```text
Trusted Tro video frame
+--------------------------------------------------------------+
| Title, consistent fonts and background                        |
| +----------------------------------------------------------+ |
| | Custom instructional visual                              | |
| |                                                          | |
| | AI-generated code: digits move / argument branches /      | |
| | code blocks highlight while a sprite moves                | |
| +----------------------------------------------------------+ |
| Narration/captions and timing supplied by maintained code    |
+--------------------------------------------------------------+
```

The custom component receives a bounded scene rectangle, saved content, current
frame, fps and duration. It returns only the instructional visual. Trusted code
owns composition registration, audio, captions, overall duration and export.
Use deterministic Remotion frame values; no live CSS animations, random layout,
downloads, package installation, model tools or runtime external assets.

### 12.2. Subjects and scene selection

The teacher supplies the existing prompt and selected class materials. Start with
automatic selection; do not require the teacher to choose an animation technique.

The content request returns ordinary baseline screen data plus a short visual
brief and optional priority for each screen. A brief states what the viewer should
understand, which objects matter and what change or relationship to show. It
should add explanatory value rather than ask for decorative motion.

The backend selects up to two eligible scenes, ordered by proposed priority with
scene position as a stable tie-break. Persist that selection once. Zero selected
scenes is valid. Intro/recap or unsuitable proposals use maintained animations.
Selection does not require another classifier, reviewer or model call. The model
proposes the teaching decision; deterministic backend rules enforce the allowance.

| Class content | Example visual brief                                            | Possible custom visual                                                                      |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Counting      | Show why only even digits can occupy the units place.           | Highlight 2, 4 and 6, move them into a group, reveal "3 choices".                           |
| Philosophy    | Explain how two theories evaluate the same dilemma.             | Reveal the dilemma, branch into two lines of reasoning, then compare conclusions.           |
| Scratch       | Explain which block runs and how repetition changes the sprite. | Highlight a displayed loop, increment a counter and move a drawn sprite for each iteration. |

A philosophy scene can also connect premises to a conclusion or introduce a
counterexample. A Scratch scene is an illustrative animation of code behavior;
embedding or executing the Scratch engine is outside this increment. Every custom
brief must stay grounded in the selected material. Teachers inspect the result;
neither compilation nor animation proves the explanation is educationally correct.

```text
Example lesson: four screens

1. Introduce the question       -> reusable animated layout
2. Show the key relationship    -> custom visual, priority 1
3. Work through an example     -> custom visual, priority 2
4. Recap the conclusion        -> reusable animated layout

All four screens have motion.
Only screens 2 and 3 request custom animation code from AI.
```

### 12.3. Two model responsibilities, one existing runner

Use two bounded model adapters, zero autonomous agents and the existing durable
API runner. No Agents SDK loop is required. Speech synthesis remains a separate
provider operation; the Docker render worker makes no language-model requests.

```text
Teacher prompt + selected material
                 |
                 v
API: authorize, snapshot input, reserve allowance
                 |
                 v
AI WRITER: one request for the whole lesson
  -> content + narration + visual briefs + priorities
                 |
                 v
POSTGRES: save screens and fixed custom-scene selection
                 |
                 v
For each saved screen:
  Speech -> save audio/duration, or select text-only mode
                 |
                 v
  Custom visual selected and allowance remains?
       | No                            | Yes
       v                               v
  Maintained layout          AI CODER: one scene only
       |                       -> small React/Remotion source
       |                               |
       |                     POSTGRES: save source + hash
       |                               |
       |                     Isolated compilation/render
       |                       | success       | code error
       |                       |               v
       |                       |       One focused repair,
       |                       |       only if attempt remains
       |                       |               |
       |                       |       Save revised source;
       |                       |       render, or use baseline
       +-----------------------+---------------+
                               |
                               v
                    POSTGRES: save completed clip
                               |
                               v
          Combine saved clips -> save final MP4 -> Ready
```

The writer request includes bounded selected source text, teacher goal, locale and
the baseline/visual-brief schema. It must not include code examples, render logs or
past lesson conversations. The coder receives only the chosen screen, its visual
brief, narration/duration, component contract and a small relevant recipe set.
Choose recipes from the brief using maintained rules; do not add a skill-selection
model request. Do not send the entire class material or other generated scenes.

The total successful first-pass path is one writer request plus at most two coder
requests. A repair gets the latest source once, its brief and a bounded concrete
compile/runtime error. It never receives all prior code revisions or full logs.
Prefer unique search/replace edits with a checked result; an ambiguous patch uses
the same remaining allowance or falls back, rather than opening another loop.

### 12.4. Bounded cost and timing

All figures below are proposed limits for this extension, not measured averages.
Start with `gpt-5.4-mini` for both roles. A different coding model requires a new
rate snapshot and admission calculation; the same dollar estimate cannot carry
over automatically.

| Work                                   | Input per attempt | Output per attempt | Total model attempts |
| -------------------------------------- | ----------------: | -----------------: | -------------------: |
| Whole-lesson content and visual briefs |            12,000 |              6,000 |                    2 |
| One custom scene                       |             6,000 |              3,000 |          2 per scene |
| Custom scene count                     |                   |                    |            At most 2 |

The input limits include instructions, schemas, examples and current source on
repair. Output limits include any billed reasoning output. Keep reasoning disabled
initially and validate that compact components fit the allowance. Count the exact
request before dispatch. Oversized animation input uses a maintained recipe set
that fits, or baseline; do not silently truncate code or explanatory material.

```text
FIRST ATTEMPTS ONLY
  Writer:       12K input + 6K output
  Two visuals:  12K input + 6K output
  ---------------------------------
  Total:        24K input + 12K output = 36K tokens

ALL ALLOWED ATTEMPTS
  Writer:       2 x (12K input + 6K output)
  Two visuals:  2 x 2 x (6K input + 3K output)
  ------------------------------------------
  Total:        48K input + 24K output = 72K tokens
```

At standard uncached rates of $0.75/M input and $4.50/M output, the first-attempt
ceiling is $0.072 and the all-attempt ceiling is $0.144 USD. These rates were checked
against [OpenAI's model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
on October 12, 2026. Cache hits may reduce cost; admission assumes no cache savings.
Speech, rendering, storage and transfer are separate costs. The existing $0.15
text-model revision allowance can cover this proposal at those rates.

The current content-only configuration allows three total transport attempts.
**This proposal reduces the writer to two total attempts** and reserves the two
scene allowances; keeping the old three-attempt writer policy would exceed the
72K-token/$0.144 calculation. Configuration validation must enforce the sum.

Admission reserves the full ceiling once. Before each paid dispatch, atomically
consume a slot from that saved reservation; do not reserve the same spend twice.
Transport retries, code repair and timeout retries share the same two-attempt count for that role or
scene. Disable hidden SDK retries for these adapters and let the existing runner
dispatch the next persisted attempt. Do not put an outer repair loop around an
SDK retry loop. Keep unknown provider usage reserved after connection loss; the
cost table is an application reservation ceiling, not a guarantee of exactly-once
provider billing or a complete invoice from incomplete usage receipts.

Continue, navigation and process restarts never replenish model attempts. A new
explicit content-generation request receives a new admission decision under the
teacher/deployment daily allowance. Exhausting a custom-scene allowance selects
baseline; it does not discard the saved lesson or completed clips.

Completion target: a few minutes for a short lesson, pending measurement. Do not
show a promised ETA from token counts. Record writer time, coder/repair time,
speech time, render time and queue time separately, then measure p50/p95 across
representative lessons. Keep per-call timeouts and the overall job deadline bounded;
stop custom work early enough to leave time for baseline rendering and combination.
A timed-out job exposes saved work and a media-only Continue action where possible.

#### 12.4.1. Graceful degradation when optional animation cannot finish

Call this behavior **graceful degradation**: reduce the optional animation treatment
while preserving the saved explanation, narration and completed work. Baseline
rendering is the fallback mechanism. Reaching an animation limit does not cancel
the lesson or discard its content.

```text
Saved content + narration
           |
           v
Try optional custom animation
           |
           +-- succeeds ------------------> render custom scene
           |
           +-- allowance/time exhausted ----------+
           |                                      |
           +-- code unusable after allowed -------+
               attempts/repair                    |
                                                  v
                                      DEGRADE to baseline animation
                                                  |
                                                  v
                                      Render -> combine -> save MP4
                                                  |
                                                  v
                                      Ready, with degradation note
```

If a model response reaches its output limit, it may contain incomplete code.
Persist it as an incomplete attempt, never as executable/accepted source. A focused
repair or complete replacement may use the existing remaining scene attempt; it
does not receive a new allowance. If that attempt cannot produce usable source,
persist the baseline treatment and continue rendering. Do not silently accept
truncated code or repeatedly increase `max_output_tokens`.

Keep the essential lesson-content reservation separate from optional animation
reservations. Animation cannot spend the writer's allowance or consume allowances
reserved for speech/baseline media work. If no valid lesson content was saved before
the writer exhausted its attempts, stop with a clear content-generation error;
graceful degradation cannot invent the missing lesson. Render outages or exhausted
media limits can also leave the video unfinished, with saved content still usable.

Persist a safe degradation reason with the affected scene, such as output limit,
animation allowance exhausted, code error or optional time exhausted. Baseline
scenes selected normally are not degraded; only an intended enhancement that was
replaced is recorded this way. Degradation is scene-treatment metadata, not a new
primary job status: a committed complete video remains `ready`, an unfinished job
is `stopped`, and an explicit cancellation is `cancelled`. Continue never resets
attempts or converts graceful degradation into an automatic new paid request.

### 12.5. Durable artifacts and recovery

PostgreSQL remains the checkpoint owner. No important result lives only in API
memory, a browser tab or container files. Extend the existing store and additive
Prisma migrations rather than creating a second job framework.

Persist baseline content first, then the visual brief, selected treatment, scene
source revisions, source digest, code/recipe/build version, render inputs, attempt
records and safe error classification. Save source before compilation or rendering.
Compilation is not source persistence, and a saved source is not a finished video.
Commit an artifact and its reference atomically using the existing revision/claim
fencing. Do not return executable source through the ordinary desktop lesson reply.

Prefer the existing screen state and immutable artifact records for brief/source
metadata and the small bounded attempt list. Validate stored JSON with an owned
schema/version and upgrade older records to baseline defaults when read. Add a
reviewed migration only where a new indexed field or relation is needed; do not
rewrite applied migrations or reinterpret retired Guided Lesson data.

| Event                                                              | Recovery                                                                               | Additional text/code model work                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Worker loses connection while rendering saved source               | Retry the same saved source and input digest within the media allowance.               | None.                                                                                      |
| API or worker restarts after source commit                         | Read saved source; resume missing media.                                               | None.                                                                                      |
| Model connection is lost before source commit                      | Keep that attempt charged/reserved; use the remaining attempt, otherwise baseline.     | At most the existing remaining attempt.                                                    |
| Source fails compilation or throws a deterministic execution error | One focused repair only if a model attempt remains, then baseline.                     | Never more than two total scene dispatches.                                                |
| Worker timeout, OOM or service outage                              | Classify as infrastructure failure; retry within media limits, then expose saved work. | None; infrastructure faults do not ask AI to rewrite code.                                 |
| Custom budget or custom time allowance is exhausted                | Persist baseline treatment and render saved screen content.                            | None.                                                                                      |
| Teacher edits one screen                                           | Fence old work and invalidate that screen's affected visual/audio/clip inputs.         | No automatic new allowance; use saved baseline unless an explicit enhancement is admitted. |
| Teacher cancels                                                    | Stop new dispatches, abort active work and preserve committed artifacts.               | None.                                                                                      |

Source/clip reuse requires matching scene content, brief, duration, presentation
mode and renderer/recipe build identity. Editing another screen does not invalidate
unchanged work. Cancellation, revision changes and expired claims reject late writes.
An in-flight model attempt after a crash consumes its allowance conservatively;
do not replay it merely because a usage receipt is missing.

```text
Continue / restart
        |
        v
Read durable scene state
        |
        +-- Clip saved and inputs match -------> reuse clip
        |
        +-- Source saved and inputs match -----> render saved source
        |
        +-- Baseline already chosen ----------> render maintained layout
        |
        +-- Custom source missing ------------> check persisted attempts
                                                  |
                                      remaining -> generate within allowance
                                      exhausted -> select baseline
```

Graceful degradation guarantees reuse of saved content, not availability of rendering
infrastructure. A baseline clip still has to render. If that render or final
combination cannot complete, leave the job stopped with usable screens/transcript
and an accurate Continue action. Only a committed full MP4 marks the lesson ready.

### 12.6. Execution boundary and minimum checks

Generated source runs only inside the QuickJS/WASM guest. It is never evaluated in
Electron, the API, the worker supervisor or Chromium. A trusted child compiles TSX
with fixed TypeScript tooling and provides only the maintained React element and
Remotion frame helpers. It installs no host I/O bindings or guest module loader.
The child starts with an empty environment. Docker alone is not the isolation
boundary.

```text
Native API: authorization, model key, saved dispatch ledger, database
                              |
                    private source + bounded props
                              v
Trusted Docker worker supervisor
                              |
                 empty-environment interpreter child
                              |
                 fixed compiler -> QuickJS/WASM guest
                              |
                bounded, validated inert SVG frame trees
                              v
Trusted maintained Remotion bundle in Chromium -> MP4
```

The guest has a hard 32 MiB WebAssembly linear-memory maximum, a stack limit and
an interrupt deadline. The supervisor kills the child after 20 seconds and caps
its output bytes. The child also has a 128 MiB V8 heap limit; that limit is not a
whole-process RSS guarantee. These limits bound guest execution and do not claim
the trusted TypeScript compiler itself is a security sandbox.

Strict SVG validation rejects active attributes, external references, raw HTML,
URLs, unsupported tags, excessive depth and oversized frame trees. The trusted
presentation owns titles, captions, fonts, audio and duration. Guest code cannot
import files, install dependencies, access network/credentials, or replace that
host frame. The supported custom canvas is 1176 by 390 logical pixels; custom
scenes longer than 90 seconds degrade to baseline.

The worker advertises the exact `quickjs-svg-v1` capability. Older workers render
baseline layouts, with a visible degradation note, and receive no generated source.
Compilation/execution failures are typed code errors eligible for the one remaining
focused repair. Worker outages stop at the saved checkpoint. There is no runtime
overflow scorer, pixel critic, AI reviewer or layout-perfection loop. Offline
math, philosophy and Scratch fixtures exercise the actual interpreter; live model
quality, latency and production Railway behavior still require rollout measurement.

### 12.7. Code ownership and configuration

Extend the current owners; do not replace the working lesson pipeline.

| Owner                                                 | Planned change                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/LessonVideos.ts`                       | Add bounded visual-brief and saved treatment/status metadata. Preserve stable server-owned scene IDs.                                                           |
| `src/contracts/LessonRenderProtocol.ts`               | Version the private protocol for custom source, fixed props and typed failures; define mixed-version rejection/compatibility explicitly.                        |
| `src/server/config/LessonVideoConfig.ts`              | Add custom enablement, model, max scenes, per-attempt input/output, attempts, source/error size and time limits; reduce writer attempts to two for this policy. |
| `src/server/config/Index.ts`                          | Validate/export the extended configuration through the existing pattern.                                                                                        |
| `OpenAiLessonContent.ts`                              | Return baseline screens and visual briefs together; keep content grounded and bounded.                                                                          |
| New `infrastructure/OpenAiLessonVisual.ts`            | Count and generate/repair one small scene through an application-owned visual provider port. No autonomous tools or hidden retries.                             |
| `LessonVideoService.ts` and `LessonVideoBudget.ts`    | Atomically reserve the full model allowance and reject unaffordable requests before dispatch.                                                                   |
| `LessonVideoRunner.ts` and `RunLessonVideoStage.ts`   | Add one persisted optional visual operation; keep explicit stage selection, bounded dispatch and media-only recovery.                                           |
| `LessonVideoPorts.ts` and `PrismaLessonVideoStore.ts` | Persist selection, source, individual attempts, safe outcomes and artifact references through typed ports/transactions.                                         |
| `src/lessonVideoPresentation/`                        | Maintain the frame, baseline layouts, reusable motion components and representative recipe fixtures.                                                            |
| `src/lessonRenderer/`                                 | Add isolated compilation/render execution behind the trusted supervisor; keep baseline rendering available.                                                     |
| `src/desktop/renderer/lessonVideos/`                  | Show stage, selected treatment and degradation; play returned media inline without evaluating generated code.                                                   |

Models, feature policy, budgets and recipe selection belong in committed config
and maintained code. API keys, renderer credentials and deployment addresses stay
in each process's validated `Env.ts`. Snapshot validated policy on job creation;
editing config cannot replenish an old job's allowance. Use existing `as const`
domain vocabulary and strict schemas at boundaries; application ports do not import
provider SDKs, Prisma, Remotion or Electron.

Keep comments focused on why attempts remain consumed after uncertain failures,
why media retries never regenerate source, and where untrusted code executes.
Avoid generic graph engines or a separate service for each stage.

### 12.8. Teacher-visible behavior and diagnostics

Keep the prompt/material creation form and inline playback. No new approval gate
is introduced. Navigating away or closing the editor does not cancel the saved job;
the explicit Cancel action owns cancellation.

Show the actual active operation: writing lesson, generating animation for scene
2 of 2, creating narration, rendering scene 3 of 5, or combining video. Counts come
from saved state; they are not an invented percentage or promised ETA. Show
custom/reusable treatment and a short visual explanation when useful.

If custom work degrades to baseline and rendering succeeds, show Ready with a concise
note such as "Video ready. Scene 3 uses standard animation." Use plain language in
the teacher interface; "graceful degradation" is the engineering term. Do not mark the whole
lesson failed merely because the optional enhancement failed. A stopped render
instead says which operation failed and whether Continue can reuse saved work.

Extend safe stage diagnostics with lesson/revision/screen ID, attempt number,
source/build digest, operation, elapsed time, typed failure and reported
input/cached/output tokens. Record an uncertain-usage flag separately. Log state
changes and the safe degradation reason when a scene switches to baseline. Log
each transition once, not repeated polling. Never log raw generated source, material,
narration, secrets, screenshots or hidden model reasoning in ordinary events.

### 12.9. Implementation order and acceptance

1. **Prove the execution boundary and reusable frame with fixtures.** Render
   counting, philosophy and Scratch examples in isolation. Demonstrate rejection
   of forbidden imports/network access and termination of infinite loops/oversized
   output. This step uses maintained fixtures, no paid model calls.
2. **Add contracts, config and durable source/attempt storage.** Use additive
   migrations and typed adapters. Prove atomic reservation, selection, source
   commit, revision fencing and crash recovery without providers.
3. **Add bounded writer/coder adapters and stage selection.** Use typed fake
   providers first. Verify at most six text/code dispatches, at most 72K admitted
   tokens, no nested retries and one common retry/repair count per scene.
4. **Integrate custom rendering, graceful degradation and inline status.** Prove that worker
   disconnect/restart causes zero additional model calls when source exists; code
   failure/budget exhaustion degrades to baseline; renderer outage retains usable
   work. Verify truncated output is never executed, writer/media reservations stay
   protected, and a completed degraded video is ready rather than failed/cancelled.
5. **Measure representative output before rollout.** With separately authorized
   paid calls, compare baseline and enhanced lessons across mathematics, philosophy
   and Scratch in EN/VI. Record total cost including failures, teacher acceptance,
   first-pass success, fallback rate and p50/p95 completion times. Keep custom
   enablement off until those results justify rollout.

Acceptance must also cover a lost model response, cancellation during each stage,
duplicate Continue, concurrent reservation, edited duration, mismatched renderer
build and delayed stale writes. A valid MP4 containing a caught error screen does
not pass. Private custom source never executes in the authenticated desktop.

Finish implementation before final validation. Use the repository's required
lint/format/type/unit checks, build and disposable-database integration checks for
runtime changes. Keep ordinary verification independent of credentials and paid
inference. Update Architecture.md only when the extension is implemented, and
README.md when its development/deployment commands change.

### 12.10. What to reuse from Remotion's starter

Use [Remotion's prompt-to-motion-graphics starter](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas)
as a reference for selected working examples, focused generation prompts and
targeted source edits. Retain Tro's existing authentication, database, runner,
budgets and Docker/Railway rendering. The starter's Next.js/AWS Lambda app does not
need to become a second Tro application.

The inspected starter does not establish Tro's durable recovery, isolation or
spending ceiling. Its initial validation/skill-selection model calls are excluded
from this plan; the writer supplies a brief and maintained rules choose recipes.
Review any reused source against [the repository's Remotion licensing terms](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas#license).
It is not presented here as an MIT-licensed animation library.

The [research notes](../research/RemotionAgentOptimizationResearch.md) contain the
inspected source revision and supporting evidence. The prototype and research are
reference artifacts; this proposed section does not claim that custom generation,
its isolation boundary, its token ceiling or its timing target already ships.

### 12.11. Concrete implementation plan and clean-code rules

This is the implementation plan for the proposed extension, not an instruction to
start paid generation or deploy it. Keep the existing lesson feature and implement
one vertical path from saved visual brief to saved clip. Add abstractions only at
real I/O boundaries or for decisions that need independent testing.

#### 12.11.1. Organize code around three small responsibilities

```text
StartApi.ts: validate config and construct concrete adapters
                         |
                         v
LessonVideoRunner: lease, wake, cancellation and shutdown
                         |
                         v
RunLessonVideoStage: choose ONE missing operation
    | content     | speech     | optional visual     | clip/combine
    |             |            v                     |
    |             |     RunLessonVisual              |
    |             |       |       |                  |
    |             |       |       +--> visual provider port
    |             |       |              ^
    |             |       |       OpenAiLessonVisual
    |             |       |       (SDK and prompt code)
    |             |       v                          |
    +-------------+--> existing store port <----------+
                              ^
                     PrismaLessonVideoStore

Pure LessonVisualRules supplies decisions to application code.
HTTP/Remotion execution stays behind the existing renderer port.
```

| File                                       | Responsibility and limits                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New `domain/LessonVisualRules.ts`          | Pure selection, reuse and next-action decisions. Receives typed state/policy/time; returns a decision. No SDK, database, filesystem, clock reads or HTTP calls. |
| New `application/RunLessonVisual.ts`       | Perform one missing visual operation, checkpoint its outcome and return control to the existing runner. No retry-until-success loop.                            |
| New `infrastructure/OpenAiLessonVisual.ts` | Build/count the exact request, call the SDK once, validate the response and return a typed outcome. Keep prompt/patch helpers private unless genuinely reused.  |

Keep the following focused functions together in `LessonVisualRules.ts`:

- `selectLessonVisuals`: stable priority selection, maximum two, persisted once.
- `chooseNextVisualAction`: choose saved-source reuse, generation, repair or
  degradation from persisted state, attempts, capability and remaining time.
- `canReuseLessonVisual`: compare the complete saved input/build identity.

Do not extract an obvious boolean into its own module, create a generic `utils.ts`,
or add a class for every function. Use `RunLessonVisual` because visual generation
is a distinct I/O responsibility; leave speech and combination with their existing
owners. Extract shared frame markup from `LessonComposition.tsx` only when custom
rendering needs the same frame, so fonts, caption spacing and timing have one owner.

#### 12.11.2. Define contracts before wiring adapters

Keep `LessonContentSchema` as the canonical editable baseline content contract.
Define a writer-output schema that adds bounded visual briefs and priorities
without making those internal decisions teacher-editable fields. Map draft scene
positions to server-assigned stable IDs when saving; reject invalid references or
duplicate briefs instead of accepting model-invented IDs.

Use canonical schemas and named `as const` objects for visual actions, treatments,
attempt outcomes and degradation reasons. Derive types from those owners. Separate
the public lesson view from private persisted state and private render input:

| Data                                                                                    | Allowed consumers                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Baseline content, intended/effective treatment, progress and safe degradation reason    | API and desktop through validated public contracts.               |
| Full source snapshot, generated TSX, model request payload and detailed attempt records | Backend persistence and owning adapters only.                     |
| Source artifact plus fixed props/build identity                                         | Authenticated private render boundary and isolated job execution. |
| Audio, clips and final MP4                                                              | Existing authorized playback/download paths.                      |

Extend ordinary artifact routes to explicitly allow media kinds. Omitting source
from lesson JSON is insufficient: knowing an artifact ID must not make generated
source downloadable through the existing generic artifact route. Keep source
artifacts distinct from playable media and validate their size/digest privately.

Add a narrow `LessonVisualProvider` port in `LessonVideoPorts.ts`, with request
counting and single-dispatch generation methods. The following is an interface
sketch; its types must come from the owning validated schemas, not duplicated
SDK shapes:

```ts
export interface LessonVisualProvider {
  countRequest(request: LessonVisualRequest): Promise<number>;
  generateVisual(request: LessonVisualRequest, signal: AbortSignal): Promise<LessonVisualResult>;
}
```

Use a discriminated result rather than `null`, unchecked assertions or one generic
exception for every expected failure:

```text
Visual-model result
  source       -> complete source/patch + available usage receipt
  incomplete   -> output limit/refusal + available usage receipt
  unavailable  -> safe transport classification + uncertain-usage flag

Private render result
  rendered     -> validated MP4 bytes
  code-error   -> bounded compilation/execution diagnostic
  unavailable  -> infrastructure classification, never an AI rewrite request
```

Cancellation/abort and stale revision/claim failures propagate to the runner;
they are not successful degradation. Unexpected database failures also propagate.
An optional animation may degrade only after its state change is committed.
Validate unknown provider/HTTP/JSON data before reading fields. Keep provider SDK,
Prisma and Remotion types out of domain/application interfaces.

#### 12.11.3. Persist each dispatch and each result

Put the bounded model-attempt list on the lesson, not inside replaceable screen
state. Maximum six dispatch records cover the writer and two scenes. Each record
identifies its role, screen ID when applicable, ordinal, request digest, saved
token ceilings, dispatch/outcome state and reported usage. IDs and digests are
backend-owned; edits cannot replace this list from public input.

```text
Build exact request from saved state
                |
Count request input; reject/degrade if it cannot fit
                |
                v
beginModelAttempt transaction
  verify current revision, record version and claim
  verify remaining reserved slot and job time
  append dispatched record and consume ONE slot
                |
             commit
                |
                v
ONE provider dispatch, SDK retries disabled
                |
                v
saveModelAttemptResult transaction
  verify claim/revision again
  save usage/outcome
  save immutable source artifact + reference together when present
                |
             commit
                |
                v
Next runner operation: render saved source, repair, or degrade
```

Extend the existing store with focused `beginModelAttempt` and
`saveModelAttemptResult` operations, using its transaction-scoped Prisma client.
Do not expose a Prisma client or generic mutation callback through the port. The
existing revision/record-version/claim checks must fence both operations, and no
transaction stays open during counting, model requests or rendering.

A crash after dispatch but before result commit leaves an uncertain consumed
attempt. The next claim can use only the remaining saved slot, or degrade. A saved
source result is reused without another generation call. Complete/incomplete
source artifacts are immutable and distinguished; only a complete accepted source
can enter isolated compilation/rendering.

Keep the current runner's control loop. `RunLessonVisual` executes one decision and
returns saved state; a subsequent runner iteration decides the next action. It
must not call itself recursively or add another scheduler. Existing media retries
may remain behind gaxios with their own persisted allowance; they cannot dispatch
language-model requests or multiply model attempts.

#### 12.11.4. Keep model requests small and failures specific

In `OpenAiLessonContent.ts`, add visual briefs to the one whole-lesson response.
The baseline lesson remains usable if every brief is absent or unselected. In
`OpenAiLessonVisual.ts`, use private, readable functions such as
`buildVisualRequest` and `applyVisualPatch`; pass the exact prepared request to
both counting and generation so they cannot disagree about context.

Start with a small versioned recipe set for text/objects, relationships and code
execution illustrations. Recipe selection is ordinary maintained code. Send only
the selected examples, public component contract and one scene. Repairs include
the latest source once and the relevant diagnostic; they do not append a chat
history or replay earlier attempts.

For a patch, require each search fragment to match exactly one region and enforce
the final source-size limit. Invalid/ambiguous patches are failed attempts and
degrade when no slot remains; do not ask another model to interpret them. Treat
output-limit responses as incomplete even if they contain a source-looking string.
Provider transport failures stay separate from deterministic code errors.

The renderer's typed error must survive `HttpLessonRenderer` parsing. Compilation
or execution errors may permit the one repair; network loss, worker OOM, timeout,
busy state or unavailable execution capability never justify AI code rewriting.
Unexpected render exceptions must not be converted into a successful error-frame
MP4. Keep cancellation signals through each adapter and terminate isolated work
on abort or deadline.

#### 12.11.5. Extend configuration and composition roots

Add one `visual` group to the existing `LessonVideoConfig.ts`, validated/exported
through `config/Index.ts`. It owns enablement, model, maximum scenes, input/output
ceilings, shared attempts, source/diagnostic limits and optional-work time limits.
Keep model rates, revision reservation and daily admission under the existing
budget owner. Validate the full worst-case sum; a change to any model/attempt/token
setting must either fit the allowance or fail startup validation.

Custom enablement defaults off until isolation and fixture acceptance pass. Preserve
renderer URL/credential and provider keys in validated process env modules. Do not
add an environment variable per animation policy or expose backend config in the
browser. Persist the validated policy/version on creation. New enhanced jobs use
the two-attempt writer policy; older baseline jobs retain their recorded settings
and accounting rather than acquiring new limits during an upgrade.

`StartApi.ts` constructs the visual adapter and injects it and the store into
`RunLessonVisual`, then injects that operation into `RunLessonVideoStage`. The
existing runner owns wake/close; no new worker deployment or background queue is
needed. Keep concrete construction in startup, with typed ports in application code.

Version private render requests and advertise supported custom-component/build
capability from the renderer. Deploy capability support before enabling enhanced
jobs. Missing custom capability selects maintained baseline; unsupported source
contracts are never silently executed against an incompatible build. Validate
older stored records into baseline defaults without losing policy, attempts,
usage, current media or cancellation state.

The trusted renderer supervisor calls a small isolated compile/render adapter.
Keep its platform mechanism explicit after the isolation spike; do not hide an
ordinary child process behind a name that promises a sandbox. Only the supervisor
handles authentication and media I/O. Generated code receives fixed props and
permitted components, with no credentials or application-network access.

#### 12.11.6. Preserve accounting through edits, Continue and degradation

Extend `LessonVideoService` edits by comparing dependency inputs per stable screen
ID. Reuse matching source/audio/clips; invalidate only affected references. Model
attempt records stay at lesson scope when screens are edited, reordered or removed.
The existing Continue/build-change path can reset eligible media counters under
its current policy, but must never reset writer/coder dispatch counts.

Implement degradation as one named application operation that saves baseline
treatment and a safe reason, then returns to the ordinary clip path. It does not
render inside a catch block, pretend a database write succeeded, or alter the
lesson's main status to `cancelled`/`failed`. Ready still requires final MP4 commit.
Continue reuses valid saved source/media; any remaining original model slot is
bounded by the same saved policy, never a new automatic allowance.

In `LessonVideoStudio.tsx` and the existing locale/label owner, derive progress and
available actions from the public view. Keep non-component status helpers in `.ts`
files, not component export modules. Account/lesson/revision keys fence stale
polling results. Play saved MP4 inline; never evaluate source or preview generated
components in the authenticated Electron renderer.

#### 12.11.7. Delivery slices, tests and clean-code acceptance

Use the order in section 12.9 to organize implementation. Finish the entire
authorized delivery's code, imports, schemas, fixtures and documentation before
running final verification; do not run checks between intermediate edits. Tests
should prove observable behavior and invariants, rather than duplicate helpers.

| Test owner                                                        | Evidence to add                                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New `test/server/features/lessonVideos/LessonVisualRules.test.ts` | Stable selection, zero eligible scenes, two-scene cap and source reuse invalidation when content/duration/build changes.                                   |
| New `test/server/features/lessonVideos/RunLessonVisual.test.ts`   | Two total dispatches shared by retry/repair; truncation/ambiguous patch degrades; saved source renders with zero new model calls.                          |
| Existing `LessonVideoRecovery.test.ts`                            | Restart, late writes, cancellation and successful degraded completion; renderer outage leaves saved content with stopped status.                           |
| Existing `PrismaLessonVideoStore.integration.test.ts`             | Concurrent final-slot admission, atomic source/reference commit, consumed uncertain attempts and old-record compatibility.                                 |
| Existing `LessonVideoRoutes.test.ts`                              | Source artifacts excluded from media endpoints; ownership and body/byte limits remain enforced.                                                            |
| Existing `UseLessonVideo.test.ts` and UI tests                    | Stale replies ignored, navigation preserves job, degraded scenes have accurate labels and Continue cannot replenish allowances.                            |
| Isolated renderer fixtures                                        | Counting, philosophy and Scratch in EN/VI, unsupported imports/network blocked, bounded runaway execution, code-error vs infrastructure-error distinction. |

Use typed fake ports and injected clock/ID/hash values for deterministic unit
tests. Keep database checks disposable and model generation scripted during
ordinary verification. A separately authorized benchmark measures real model
quality, retries, token spend and timing; unit tests cannot establish those results.

Review the implementation for these concrete properties:

- Application/domain files contain no provider SDK, Prisma or renderer execution.
- Strict schemas own boundary types; no `any`, unchecked casts, non-null assertions
  or TypeScript/ESLint suppressions hide errors.
- A new teammate can follow selection -> saved attempt -> provider -> saved source
  -> rendering -> degradation without opening a generic graph engine.
- Action-first names describe reads, decisions and writes honestly. Helpers stay
  with their owner and meaningful spacing keeps control flow readable.
- Short JSDoc documents port side effects and units. Comments explain uncertain
  billing, claim fencing and execution isolation; they do not narrate obvious code.
- Logs are bounded stage events. Source/material/credentials and hidden reasoning
  are absent from ordinary diagnostics.

For runtime implementation, finish with `pnpm lint`, `pnpm format:check`,
`pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm test:integration`, after all
scoped edits are complete. Report any failures and unrun checks. This documentation
update itself does not run paid jobs, change configuration or enable execution.
