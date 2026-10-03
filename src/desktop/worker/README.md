# Worker ownership

The two startup files remain here because Electron builds them as named utility-worker entry points. Features use direct relative imports; there are no forwarding modules or barrel exports.

| Folder        | Responsibility                                                                      | Start here                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`       | Compose and run the SDK task, select instructions, log model exchanges              | [ComputerUseTaskRunner.ts](agent/ComputerUseTaskRunner.ts), [CreateComputerUseAgent.ts](agent/CreateComputerUseAgent.ts)                                                      |
| `teaching`    | Keep the original lesson goal, admit steps, present instructions, assess completion | [TeachingTaskRunner.ts](teaching/TeachingTaskRunner.ts), [TeachingLessonContext.ts](teaching/TeachingLessonContext.ts), [TeachingPresenter.ts](teaching/TeachingPresenter.ts) |
| `observation` | Read local screen/input revisions, capture baselines, decide when to resume         | [DesktopObservationClient.ts](observation/DesktopObservationClient.ts), [TeachingObservationPolicy.ts](observation/TeachingObservationPolicy.ts)                              |
| `execution`   | Own action-task lifecycle, evidence, budgets and completion verification            | [TaskHarness.ts](execution/TaskHarness.ts), [TaskVerifier.ts](execution/TaskVerifier.ts), [CompletionGate.ts](execution/CompletionGate.ts)                                    |
| `cua`         | Connect to native tools, restrict tool access, validate guidance receipts           | [LoggedCuaServer.ts](cua/LoggedCuaServer.ts), [CuaCompanionClient.ts](cua/CuaCompanionClient.ts)                                                                              |

Tests mirror these folders in [test/desktop/worker](../../../test/desktop/worker/README.md). This organization describes ownership; it does not introduce new runtime layers or change public contracts.
