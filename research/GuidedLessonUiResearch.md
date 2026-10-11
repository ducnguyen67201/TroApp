# Guided lesson creation: UI research and concepts

_Research snapshot: October 10, 2026 · 21 public sources · Moderate confidence in the design recommendation. Design exploration, not implemented product behavior._

## Recommendation

Use a short guided creation flow, then a scene-based review workspace. Keep preparation focused, with source references beside the code during comparison. Teachers should see what they are teaching, which source passages support it, and what needs their attention next.

The screenshot presents source excerpts, lesson settings, two code examples, confirmations and generation details in one long form. My assessment is that its hierarchy makes a bounded teaching task feel like configuring a technical tool. This is a design hypothesis based on the screenshot and source code; it has not been tested with teachers.

The HTML exploration offers three alternatives:

| Direction                              | Best fit                                           | Main benefit                                                                    | Tradeoff                                                             |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **A. Từng bước — guided flow**         | Teachers creating their first few lessons          | Separates preparation into a small number of understandable decisions           | Needs a way to consult selected sources while editing code           |
| **B. Không gian soạn bài — workspace** | Teachers who frequently compare source and example | Places reference material beside the active task                                | Denser and less comfortable on smaller screens                       |
| **C. Bản soạn gọn — compact brief**    | Repeat users with their source and examples ready  | Lets teachers scan and revise the whole preparation through expandable sections | Collapsed sections need clear completion and missing-input summaries |

**My choice: A for creation, with B's side-by-side source access during code review.** After generation, use a storyboard for script and media review. C is a useful alternative to test with experienced teachers; offering all three as production modes would add unnecessary navigation and maintenance.

Open the [interactive HTML concepts](../examples/previews/GuidedLessonCreationConcepts.html). All example content is synthetic. Actions in that file are local simulations; they do not save a draft, call AI, render a video or release a lesson.

A separate [scene studio exploration](../examples/previews/GuidedLessonSceneStudio.html) follows the user's later video-editor references: a dominant teaching frame, a visual scene strip and a contextual narration/Python/source inspector. It explores script review after preparation, with four synthetic accumulator scenes and explicit local review states. The user-invoked `gan-design` and `gan-style-harness` generator/evaluator loop uses the design weights 35% quality, 30% originality, 25% craft and 10% functionality. Evaluation is source-based and provisional because automated local-file browser previews were blocked; offline interaction checks do not establish rendered visual quality. This is a standalone prototype, not a change to Tro's runtime or approval requirements.

## What Tro actually supports today

This exploration follows the existing [preparation form](../src/desktop/renderer/guidedLessons/GuidedLessonPreparation.tsx), [teacher studio](../src/desktop/renderer/guidedLessons/TeacherLessonStudio.tsx), [contracts](../src/contracts/GuidedLessons.ts) and [implemented architecture](../docs/Architecture.md#guided-lessons-beta). Those files remain the owners of runtime behavior.

- A teacher chooses an approved publication and section, states a learning objective and audience, and selects English or Vietnamese. The current UI offers 1, 3 or 5 minutes.
- The teacher chooses up to eight exact source passages. Published corrections remain distinct source entries and must remain available for inspection.
- The supported code is a restricted Python integer running-total example. The teacher supplies and confirms it against the selected source. An independently confirmed practice example is required by the current form when the selected duration exceeds one minute.
- Creating the lesson starts script generation. The teacher then reviews and approves the script before making a private narrated video preview.
- The teacher must inspect the required scene phases and evidence, approve the exact preview, and separately release it to the class. Editing invalidates dependent approvals.

This is a narrower and more accountable workflow than a general text-to-video prompt box. The UI should explain those boundaries early, without requiring the teacher to understand implementation details.

## Comparable platforms: what to borrow

These findings describe public documentation checked on the research date. They do not establish that the products validate Python examples or enforce Tro's teaching approvals.

| Reference                                                                                                                                                            | Documented pattern                                                                                                                           | Implication for Tro                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Google Video Overviews](https://support.google.com/gemininotebook/answer/16454555?hl=en) — current help, undated                                                    | Source notebook → Studio → format/language/style/focus → background generation                                                               | Keep setup understandable and the output easy to revisit. This help does not document an editable script-approval step. The previous NotebookLM help URL now redirects to Gemini Notebook help.                                     |
| [Google's Video Overviews launch](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/) — July 29, 2025 | Describes narrated visuals from source material and steering by audience, learning goal and focus                                            | Put the teaching goal before visual customization. Use current help for current behavior; this is a launch reference.                                                                                                               |
| [Synthesia Assistant help](https://help.synthesia.io/en/articles/13759605-how-do-i-create-a-video-using-assistant) — “updated this week” when read                   | Topic, audience and objective → editable numbered outline → editor or generation. Storyboard co-locates script, scene visuals and assistance | Give the teacher a reviewable teaching structure before video production. Scene review belongs in a workspace, not underneath a long creation form.                                                                                 |
| [Synthesia Assistant documentation](https://docs.synthesia.io/docs/assistant) — undated                                                                              | Separates importing a finalized script from creating a new script using supporting files                                                     | Clearly distinguish teacher-approved content from generated explanation. The help and docs differ on storyboard column order; the co-location pattern is the reliable finding.                                                      |
| [Colossyan Document to Video](https://www.colossyan.com/features/document-to-video/) — undated product page                                                          | Markets editable scene plans with source-section citations and approval before rendering                                                     | Closest reference for pairing a scene with its supporting passage. This is a publisher claim, not independently verified availability. Source-change rereading is labeled roadmap/coming soon.                                      |
| [Colossyan rebuild announcement](https://www.colossyan.com/posts/ai-video-generator-rebuilt/) — updated June 10, 2026                                                | Describes draft/direct/export and scene-level revision, with early-access onboarding in batches                                              | Supports the scene-review direction, while qualifying feature availability. No speed or cost claims from the announcement are adopted here.                                                                                         |
| [Guidde file-to-video workflow](https://help.guidde.com/en/articles/11410533-create-guiddes-from-a-file-pdf-pptx-docx) — September 1, 2026                           | Import → select slides/pages using checkboxes → narration settings → generate → editor                                                       | Make the selected source subset visible and comprehensible. Tro can borrow the selection pattern while keeping its exact passages and corrections. Guidde's imported PPT slides become static steps; transitions are not preserved. |
| [Guidde video editing](https://help.guidde.com/en/articles/9790578-editing-guidde-videos) — “updated this week” when read                                            | Step navigation, editing and timing, with narration-dependent duration limits                                                                | Keep each teaching scene understandable and reviewable. Tro should not offer independent timing controls that conflict with exact approved narration.                                                                               |
| [Descript Quick Design](https://help.descript.com/ai-assistant/quick-design) — undated                                                                               | Applies scenes/layout/style to existing script media, presenting the output as a rough cut                                                   | Call the first output a draft. Do not imply that generating once produces a finished lesson. Its documented starting-project requirements limit the analogy.                                                                        |
| [Canva Presentations](https://www.canva.com/presentations/) — undated product page                                                                                   | Audience/style/length → prompt → view and edit outline → generate a design                                                                   | Show teaching structure before decoration. This is a presentation workflow, not evidence of source-grounded code checks or teacher approval.                                                                                        |

The recurring pattern is a structured brief followed by an editable outline or scene-based output. **My design inference** is to combine that pattern with Tro's existing source and code confirmations, rather than adding an unrestricted prompt, avatar picker or editing timeline to the preparation screen.

## Dribbble references: composition, not product evidence

The actual images on all six shot pages were visually inspected. Dates below are from the public **Shot details → Posted** field. These are portfolio references; neither a polished image nor its author's description establishes working functionality or tested usability. The HTML uses original layout and styling, with no copied shot assets.

| Shot and attribution                                                                                                                                                             | Visible composition                                                                                                  | What to take from it                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Lesson Creator – Montra](https://dribbble.com/shots/19315139-Lesson-Creator-Montra), Dominik Tyka for Creme Digital — September 6, 2022                                         | Numbered slide rail, large preview, and Record Slide / View Script / Edit Clip actions                               | **Strongest review-screen reference.** Make a lesson feel like familiar teaching slides, and keep narration close to the scene. Older, but directly relevant to the task.        |
| [AI Video Generation](https://dribbble.com/shots/27752080-AI-Video-Generation), Ehan Malik — September 23, 2026                                                                  | Scene imagery paired with descriptions, a horizontal storyboard and a contextual assistant panel                     | Pair each teaching scene with its explanation. For Tro, use that contextual space for supporting source material.                                                                |
| [AI Assistant – Image to Video Generator Mobile App UI](https://dribbble.com/shots/27155986-AI-Assistant-Image-to-Video-Generator-Mobile-App-UI), Fahim Faysal — March 9, 2026   | Separate prompt, reference-selection and storyboard screens, with selected references visible in the selection sheet | **Strongest creation-sequence reference.** Separate decisions while keeping the chosen source accessible. Adapt the hierarchy to desktop rather than copying the mobile screens. |
| [AI Video Editor Dashboard UI – SaaS Web App Design](https://dribbble.com/shots/27604005-AI-Video-Editor-Dashboard-UI-SaaS-Web-App-Design), Oron Creative Studio — July 29, 2026 | Central preview, left media rail, numbered scene cards and tracks below                                              | Borrow scene-card legibility and preview prominence. A full editing timeline would be a substantial new capability, not a cosmetic change to Tro.                                |
| [BetterLearn: AI-powered Learning Platform](https://dribbble.com/shots/26359063-BetterLearn-AI-powered-Learning-Platform), WebBuddy — August 4, 2025                             | Light surfaces, educator/student role cards, teaching-tool cards with one-line purposes                              | Borrow understandable teacher-facing labels. The inspected image is an entry screen and does not demonstrate a lesson creation flow.                                             |
| [AI Video Creation Dashboard](https://dribbble.com/shots/26879920-AI-Video-Creation-Dashboard), Yunus Emre POLAT — December 13, 2025                                             | Recent-video thumbnail grid, named actions and a prominent Create New action, alongside analytics                    | Useful for returning to finished lessons. Large analytics cards should not dominate the creation screen.                                                                         |

**Design inference:** combine Montra's slide-based review with Fahim's separated preparation stages, then add Tro's source references and explicit review statuses. Preserve Tro's warm visual identity instead of copying the darker production-tool treatments.

## Changes suggested by the screenshot

Feedback on the HTML concepts found the default view too wordy. The revised proposal starts directly with the active form beneath one compact comparison toolbar, with compact status chips and collapsed optional settings showing their current values. Page slogans, breadcrumbs and duplicate step headings are removed; workflow information remains available on demand. Remove repeated guidance and sidebar prose; show help when the teacher needs it. These are changes to the design exploration, not Tro's runtime or approval requirements.

### Make source selection readable

Use compact source title rows with a selection checkbox, a correction badge where relevant, and a separate disclosure control labeled for the specific passage. Open the exact source text and detailed metadata on demand instead of repeating excerpts in the default view. Show **2 / 8 đã chọn** beside the section heading. Keep corrections clearly labeled and directly accessible during code review.

Put repeated footer and copyright text inside the full-source view. This is presentation only: preserve the original published text, citation ranges and correction relationships. Do not rewrite the approved material or silently discard text from the generation packet.

The current teacher-input response contains publication and section titles, passage text, material IDs and page IDs; it does not supply friendly material filenames or human page numbers. Labels using those extra metadata would require a deliberate contract/adapter change or an existing authorized metadata lookup. The prototype uses synthetic readable labels to demonstrate the desired presentation.

### Make the Python step understandable

Use a legible monospaced editor with a concise statement of the supported example. Place selected sources alongside it or in an immediately accessible drawer. Separate **Ví dụ giải thích** and **Bài tập tự làm**, and explain why the second example is needed for longer lessons. Preserve explicit teacher confirmations, and reset them when their code or source changes.

A sample should be clearly marked as an illustration until the teacher relates it to the selected publication. Do not imply that syntax highlighting is code execution or validation. New automatic extraction, code suggestions or local draft persistence would be separate implementation work.

### Make generation and review predictable

Use a final preparation summary and an action such as **Tạo kịch bản**. Then expose the real next stages: **Duyệt kịch bản → Tạo video xem trước → Duyệt video → Phát hành cho lớp**. State which actions start generation and retain the existing allowance information behind a clear details control before dispatch. Do not invent a price or a render-time estimate.

In script review, pair each scene with its narration and supporting source. In media review, distinguish opening a scene from actually confirming its required phases and evidence. A single large “Publish” button must not collapse the existing approval sequence.

### Use actionable feedback

Missing input should be described near the relevant field, for example **Chọn ít nhất một đoạn nguồn** or **Xác nhận ví dụ luyện tập trước khi tiếp tục**. A service or stored-data failure should have different copy from an error the teacher can correct. GOV.UK's guidance makes that distinction and recommends explaining how the user can recover. [Error messages](https://design-system.service.gov.uk/components/error-message/)

## Evidence from interaction-design guidance

NN/G recommends organizing forms around a logical sequence, clear requirements, familiar labels and examples. Its July 2025 guidance supports showing only relevant fields and making progress understandable. These principles support splitting Tro's preparation into a few coherent tasks and keeping optional instructions secondary. [Reducing cognitive load in forms](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/)

There is an important qualification: staged disclosure works poorly when users must repeatedly alternate between dependent inputs. Source and code comparison is exactly that risk in Tro. Keep source access available inside the example step rather than forcing repeated Back/Next navigation. [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)

GOV.UK's question-page guidance supports focused tasks and carrying entered answers forward. Its check-answers pattern provides a useful model for a concise final summary with direct Change actions before an explicit submission. These are reference patterns, not evidence that one exact layout will outperform alternatives for Tro teachers. [Question pages](https://design-system.service.gov.uk/patterns/question-pages/), [Check answers](https://design-system.service.gov.uk/patterns/check-answers/)

## Research method and limits

The decision is how to make Tro's current teacher workflow friendlier, with working HTML concepts for comparison. The research questions were:

1. Which parts of the current creation form make the task hard to understand?
2. How do comparable platforms move from source material to a script and video?
3. Which Dribbble compositions are relevant to source selection, creation and review?
4. Which established interaction patterns fit Tro's approval and source requirements?

The requested deep-research skill was used to guide source selection and synthesis. Exa and Firecrawl were not exposed as callable tools in this session, so research used targeted web queries, public-page reads and browser inspection. The 21 public sources comprise 10 official platform pages, six visually inspected Dribbble shots, and five interaction-design references. The linked comparison tables and guidance paragraphs above serve as the source inventory. Multiple workflow pages were read beyond search snippets; local code was inspected separately.

Official platform documentation was preferred over third-party feature lists; Dribbble was treated as visual inspiration. No account was created, paid generation started, or external resource changed. Product findings describe public documentation, not a hands-on audit of authenticated editors. Older design guidance and the 2022 Montra shot are explicitly included for their relevance to the interaction, rather than their recency.

Confidence is high in the current Tro workflow because it was checked against local source. Confidence in documented product flows depends on each publisher's documentation; availability and editor layout can vary. Confidence in the proposed improvement is moderate until teachers try the concepts. No claim about conversion rates, time saved or generation quality is made.

For a next design check, ask a small group of teachers to prepare the same synthetic lesson in A and C, then review a sample storyboard. Observe source-selection mistakes, unconfirmed examples, unnecessary backtracking, and whether they can explain what happens after “Tạo kịch bản.” Treat those observations as formative evidence, not a statistical usability benchmark.
