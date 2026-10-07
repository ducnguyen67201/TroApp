# Compact material context implementation

Implemented October 4, 2026. This is the delivered behavior; the
[engineering plan](MaterialContextEngineeringSpec.md) records the broader design.
Live provider quality and interactive student acceptance still need a teacher review.

## Teacher workflow

Upload the original files, add optional instructions, and click Prepare materials.
The backend saves extracted source units, generates a compact brief per document,
then composes a class overview and suggested sections from those briefs. One button
starts one durable job, with several bounded model calls. Preparation progress shows
completed documents and the final composition stage.

The review retains Summary, Sections and Material notes. Material notes show one
expandable document brief rather than a generated paragraph for every page. Teachers
can edit a separate document correction, restore the generated brief, inspect exact
source text, and add page corrections. Approval still requires review. Originals are
available for authorized download; publishing creates an immutable course revision.
A live session continues using its pinned revision.

Reopening a class reads its existing originals and saved review; no new upload is
required. Originals appear before the uploader. The previous review stays visible
(read-only) while preparation runs, after a failure, or when the source collection
changes. Loading errors end the loading indicator and offer Refresh materials.
Late responses from another class and older preparation versions are discarded.

Teachers can use **Ask AI to adjust suggestions** to enter a revision request. Any
unsaved review edits are saved first; a failed save prevents preparation. The existing
`prepare` command accepts an optional, bounded `revisionRequest`. It is persisted in
the private job document so a restarted runner can resume the job. Composition receives
the saved summary, section wording, current document briefs, teacher corrections and
the request. Original extraction and unchanged briefs are reused. Previous suggestions
are guidance rather than source evidence; generated citations must still bind to current
sources. A successful revision returns to Review and clears the private job request.
Regular Prepare again rebuilds suggestions from materials and teacher instructions.
Neither action approves the draft or changes a live session's published context.
No database migration is required for the optional JSON job field.

Main emits `classroom.materials.request.failed` with operation, class ID, HTTP status,
safe refusal code or validation issue count. Backend `classroom.materials.refused`
distinguishes a classroom rule, invalid stored/public contract, and unexpected error.
These diagnostics omit source content, teacher instructions, cookies and error bodies.

## Code and ownership

| Responsibility                                          | Implementation                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Validated brief, passage, packet and generation records | `src/contracts/MaterialContext.ts`                                          |
| Versioned drafts and compatibility commands             | `src/contracts/ClassroomMaterials.ts`                                       |
| Extraction reuse and approval transactions              | `src/server/features/materials/application/MaterialService.ts`              |
| Durable brief/composition stages                        | `src/server/features/materials/application/PrepareMaterialCollection.ts`    |
| Generation/counting port                                | `src/server/features/materials/application/MaterialGeneration.ts`           |
| Backend OpenAI adapter                                  | `src/server/features/materials/infrastructure/OpenAiMaterialPreparation.ts` |
| Exact source ranges and lexical ranking                 | `src/server/features/materials/application/MaterialSourceSelection.ts`      |
| Token-based selection                                   | `src/server/features/materials/application/MaterialTokenBudget.ts`          |
| Authorized search and bounded reads                     | `src/server/features/materials/application/ReadMaterialSources.ts`          |
| Selected student context                                | `src/server/features/materials/application/MaterialLessonContext.ts`        |
| Persistence and conditional claims                      | `src/server/persistence/PrismaClassroomStore.ts`                            |
| Editable document review                                | `src/desktop/renderer/classroom/DocumentBriefReview.tsx`                    |
| Worker evidence/history projection                      | `src/desktop/worker/teaching/MaterialEvidence.ts`                           |
| Whole request token admission                           | `src/server/auth/CountModelInput.ts`, `RegisterModelGateway.ts`             |

The additive migration is
`prisma/migrations/20261004190000_material_context/migration.sql`. It adds a
class-scoped derivation table; existing originals and publications are unchanged.
Do not reset the database. Normal development startup applies pending migrations.

## Preparation bounds and reuse

The backend hashes the material input, original PDF digest, extraction version,
locale, provider/prompt version, output limit and generation stage. Unchanged briefs
are reused without generation or counting calls. Teacher instructions and document
corrections change composition without regenerating unchanged source briefs.
Large text/code documents are grouped and reduced. PDFs are sent with their text and
original visual input in a single document stage; an oversized PDF is refused, not
silently truncated. PDF page partitioning is deferred.

Each uncached stage is counted using OpenAI's input-token endpoint before generation.
The job reserves input/output allowances and writes a claim before the provider call.
Completed stages remain reusable after a later failure. Unknown outcomes are marked
uncertain. They require an explicit teacher retry; the runner does not replay them.
Claims and collection versions prevent stale completions from overwriting newer work.
A retry uses a new job allowance and replaces the latest uncertain claim for that key;
the cache is not a historical billing ledger. Existing daily preparation limits remain.

Defaults, validated in backend `Env.ts`:

| Setting                        | Default                          |
| ------------------------------ | -------------------------------- |
| `MATERIAL_JOB_CALLS`           | 24                               |
| `MATERIAL_JOB_INPUT_TOKENS`    | 150,000                          |
| `MATERIAL_JOB_OUTPUT_TOKENS`   | 48,000                           |
| `MATERIAL_STAGE_INPUT_TOKENS`  | 64,000                           |
| `MATERIAL_STAGE_OUTPUT_TOKENS` | 2,000                            |
| `MATERIAL_JOB_DEADLINE_MS`     | 540,000                          |
| `MODEL_CONTEXT_TOKENS`         | 100,000 including output reserve |

Limits are enforced incrementally. A later stage may exceed a job allowance after
earlier briefs succeeded; those completed briefs remain cached for review/retry.
Logging contains stage, job ID, cache hits, counts and safe failure diagnostics.
Source contents, screenshots and provider bodies are excluded from ordinary logs.

## Student context and drawings

New desktop clients request material schema version 2. For V2 publications, the
backend selects setup dependencies, teacher corrections, a small document/topic
index and question-relevant exact source passages. It targets 4,000 local text tokens
and caps the serialized material packet at 8,000 using bundled o200k ranks. Required
sources that cannot fit are reported as missing; they are not shortened to pretend
that the context is complete. Excessively large base notes return a null packet and
require a shorter teacher review.

`search_class_material` ranks exact source text as well as headings, topics and
teacher corrections, including material outside the current section. It returns up
to eight matches within 800 estimated text tokens. `read_class_material_source`
returns evidence within 1,200 tokens, with explicit source IDs and continuation
offsets for long text/code and page corrections. Neighbor/source-unit reads expose
ordered related passages. The original source remains unchanged. Retrieval requires
current enrollment, participation/device lease, context version, activity and the
session's pinned publication; arbitrary IDs cannot access another class.

The worker excludes download metadata from the model packet and evicts complete
older exchange groups when retained material evidence exceeds 8,000 text tokens.
The model gateway independently counts the complete request, including tools,
response schema, images and history. Oversized requests are refused before response
generation. Counting failures fail closed. This adds one counting request per model
turn; no model content is logged by this gate.

Source tools do not draw or click. They supply reference evidence to the existing
teaching agent. The agent must observe the live screen, then call the existing
`present_teaching_step` tool to present instruction and drawing together. Its
capture/goal/receipt checks remain unchanged. Documents never provide live click
coordinates or authorize actions.

## Compatibility, removals and practical limits

V1 publications remain readable. Legacy clients receive a V1 projection of V2
reviews and cannot save over V2 drafts without the version capability. Existing
approved lessons are not automatically regenerated. Re-prepare and review a lesson
to adopt compact V2 source selection.

Removed: collection-wide per-page note synthesis; the requirement to assign every
retained page to a teaching section; character-only student packing; and the old
provider tests requiring a generated note on every page. Tests now cover brief reuse,
limits, unknown outcomes, citation validation, exact continuations, authorization,
compatibility, teacher edits and database claim fencing. Authentication, enrollment,
publication, submission, original-download and presenter tests remain.

Retrieval is deterministic lexical ranking with accent normalization, not semantic
or cross-language retrieval. URLs remain references; their pages are not fetched.
Diagrams are interpreted during PDF generation but exact visual source retrieval is
not implemented. All retained text can be read; a brief is not a claim of lossless
visual understanding. No embeddings, vector database, background historical-cache
cleanup, provider-quality benchmark or automatic grading was added.

## Acceptance

Run the repository's final lint, formatting, type, unit, build and disposable database
integration checks. Unit provider calls use synthetic SDK responses; integration
uses offline generation and a disposable PostgreSQL database. No live paid model
calls are required for these checks.

After restarting the API and desktop, manually prepare several documents, review
briefs, correct the practice environment, approve, join as a student and ask about a
prerequisite in an earlier document. Verify source retrieval and the actual instruction
and drawing together. This manual check remains necessary for model quality and native
presentation behavior; passing storage/contract tests does not establish either.
