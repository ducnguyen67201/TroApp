# Documentation

Start with [Architecture](Architecture.md), [Development](Development.md) and [Verification](Verification.md). [Codex navigation](CODEX-NAVIGATION-GUIDE.md) maps ownership and common change paths.

| Feature                  | Main documents                                                                                                                                                                                                                         | Supporting material                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Agent execution          | [Computer use](agent/ComputerUseSpec.md), [Task harness](agent/AgentHarnessSpec.md), [Completion](agent/TaskCompletionSpec.md)                                                                                                         | [Prompt research](agent/AgentPromptResearch.md)                                              |
| Teaching                 | [Companion plan](teaching/TeachingCompanionPlan.md), [Observation design](teaching/TeachingObservationDesign.md), [Input-driven plan](teaching/InputDrivenObservationPlan.md), [Executable contract](teaching/TeachingFlowContract.md) | [HTML demo](teaching/TeachingCompanionDemo.html)                                             |
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
