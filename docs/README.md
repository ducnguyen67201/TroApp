# Documentation

Start with [Architecture](Architecture.md), [Development](Development.md) and [Verification](Verification.md). [Codex navigation](CODEX-NAVIGATION-GUIDE.md) maps ownership and common change paths.

| Feature                  | Main documents                                                                                                                                                                                                                         | Supporting material                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Agent execution          | [Computer use](agent/ComputerUseSpec.md), [Task harness](agent/AgentHarnessSpec.md), [Completion](agent/TaskCompletionSpec.md)                                                                                                         | [Prompt research](agent/AgentPromptResearch.md)                                              |
| Teaching                 | [Companion plan](teaching/TeachingCompanionPlan.md), [Observation design](teaching/TeachingObservationDesign.md), [Input-driven plan](teaching/InputDrivenObservationPlan.md), [Executable contract](teaching/TeachingFlowContract.md) | [HTML demo](teaching/TeachingCompanionDemo.html)                                             |
| Classroom context        | [Classroom engineering spec](classroom/ClassroomContextEngineeringSpec.md)                                                                                                                                                             | [Implementation and pilot setup](classroom/ClassroomImplementation.md)                       |
| Cursor companion and HUD | [Setup](companion/CursorCompanion.md), [Engineering](companion/CursorCompanionEngineering.md), [Guidance](companion/CursorCompanionGuidanceSpec.md), [Voice bar](companion/CursorCompanionVoiceBarPlan.md)                             | [Audit](companion/CursorCompanionAudit.md), [Preview](companion/CursorCompanionPreview.html) |
| Voice and microphones    | [Voice input](VoiceInputSpec.md), [Microphone selection](MicrophoneSelection.md), [Hardware checks](MicrophoneHardwareChecks.md)                                                                                                       | [Desktop UI](DesktopUi.md)                                                                   |

[Worker ownership](../src/desktop/worker/README.md) and [test organization](../test/README.md) explain the corresponding code layout. The audit and research documents provide supporting context; the feature specs describe current behavior and its limits.

The proposed [teaching loop engineering spec](teaching/TeachingLoopEngineeringSpec.md)
maps the next refactor to current files, identifies removals and preserves paired
instruction/drawing presentation. It is a plan, not a delivered runtime change.

The ElevenLabs HUD voiceover feature has a
[specification](companion/HudVoiceoverSpec.md),
[engineering design](companion/HudVoiceoverEngineering.md) and
[delivery plan](companion/HudVoiceoverPlan.md). These cover localized narration,
backend streaming and usage limits, presentation timing and cancellation.
Local wiring is implemented; live provider and signed hardware acceptance remain.

The proposed student pet feature has an
[engineering specification](companion/StudentPetSpec.md) and
[implementation plan](companion/StudentPetPlan.md), covering bundled pets,
desktop interactions, collections and prompt-generated appearances. The
[initial local implementation](companion/StudentPetEngineering.md) provides bundled
pets; generated pets remain planned and signed platform acceptance is pending.

The [classroom context engineering spec](classroom/ClassroomContextEngineeringSpec.md)
consolidates the proposed course/class architecture and implementation sequence.
The [implementation record](classroom/ClassroomImplementation.md) distinguishes
the initial classroom flow from deferred formats and integrations.

- [Materials preparation](classroom/MaterialPreparationEngineering.md) — uploads, batch extraction, teacher review and approved context.
- [Compact material context plan](classroom/MaterialContextEngineeringSpec.md) — document briefs, source retrieval, token budgets, compatibility and implementation cleanup.
- [Compact material context implementation](classroom/MaterialContextImplementation.md) — delivered flow, code ownership, limits, migration and acceptance.
- [Practice checks and tutoring](classroom/PracticeCheckEngineeringSpec.md) — implemented formative-check pilot, private work snapshots, approved criteria, revisioned hand-ins and targeted teaching; future adapter milestones.
- [Classroom experience prototype](classroom/ClassroomExperienceDemo.md) — interactive student and teacher HTML mock with sample data.
