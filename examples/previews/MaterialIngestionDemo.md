> UI/workflow prototype reference. Current implemented behavior lives in
> [Architecture](../../docs/Architecture.md). This demo is not acceptance evidence.

# Material ingestion demo

[Open the interactive HTML](MaterialContextDemo.html).

This is a standalone, local prototype. It simulates extraction from two illustrative
Scratch materials. Added files and links are listed but never read, uploaded or
interpreted. Download controls for originals are placeholders; Notes export as Markdown is real.
No backend, model, session or storage integration is implemented here.

## Teacher workflow

Add files and links → optionally describe today's intent → Prepare materials → review
Summary, Sections and Material notes → use the reviewed materials → choose the
starting section → start. Teachers can edit each section's name and instruction,
and the prepared notes for each individual page or project. Source extraction is
retained alongside teacher revisions; the original downloadable file is unchanged.
New materials require a new preparation. Teacher-instruction changes only require
review, without re-extracting the materials. Technical agent packets are not shown
in the teacher interface.

Preparation is deliberately explicit. Teachers often have several complementary
files. Running a separate model synthesis on each drop creates partial drafts,
unnecessary cost and repeated review. Prepare once after the collection is ready.
Later additions produce a new draft without silently replacing approved context.

## What one batch means

One preparation API request creates one bounded background job for a material
collection. It does not mean every step is a single HTTP request or model call.
File transfers happen separately, usually directly to private storage. Local or
server parsers extract supported content. Synthesis combines extracted content and
teacher intent. Large collections may require multiple bounded model calls, chunks,
retries and partial failure reporting. Cache extraction by file version/content hash
so changes do not re-extract unchanged files. This is a proposal, not implemented API.

Do not upload an entire large collection into one model request just to claim one
call. Show preparation progress without blocking the teacher. A class may start
without AI context; assistance must clearly report when context is still unavailable.

## Prepared data

Keep originals separate from readable Markdown and structured metadata. Track material
IDs, content versions, section IDs and source locations. Distinguish source-derived
instructions, teacher notes, inferred suggestions and unresolved questions. The demo
shows an absent Scratch start event as a suggestion requiring a teacher decision,
rather than fabricating a requirement from the slides.

Approval pins a context revision for the session. Student assistance receives relevant
reviewed sections plus session focus and actual desktop evidence. Joining alone does
not send all originals to a model. Material content is untrusted reference data; it
cannot authorize actions or override agent instructions. Python and Scratch files
must be parsed as data, not executed during ingestion. Supported formats, file limits,
private storage permissions and parser boundaries need their own implementation spec.

## Preserve content, not only a summary

The summary is navigation over the material, not its replacement. In the intended
ingestion workflow, retain every page/slide in order, headings, body text, examples,
code, tables and links, with visual descriptions or referenced image assets where
needed. Keep page-level source references and original files. Do not discard detail
to fit one model request; retrieve relevant sections from the retained content.

Track extraction coverage and unreadable or ambiguous regions. Do not claim complete
interpretation merely because a parser returned text. Flag unsupported formats,
failed pages, missing diagrams or uncertain OCR for teacher review. Completion means
accounting for the source content, not declaring every visual understood.

The demo shows six illustrative PDF pages plus a project record, including extension
activities and diagram descriptions. These are simulated samples, not extraction
from actual uploaded files. A teacher revision is a separate layer over the original
extracted content. Agent-ready context includes source-derived material, teacher
revisions and section focus with clearly distinguished provenance. Uploaded content
remains reference data, not tool authorization.

## Product implementation

The product now implements this workflow. See [MaterialPreparationEngineering](../../docs/Architecture.md#classroom-and-materials)
for the real API, parser boundaries, approval/version behavior and supported formats.
The standalone demo above still uses illustrative data.
