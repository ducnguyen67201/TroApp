# Worker tests

The `agent`, `teaching`, `observation`, `execution` and `cua` folders mirror [worker source ownership](../../../src/desktop/worker/README.md).

The `teaching/flow` folder contains the Electron journey harness, renderer fixture, scripted model/MCP peer and optional native boundary check. These fixtures are built by `scripts/CheckTeachingFlow.ts`; they are separate from Vitest discovery.

See [the teaching contract](../../../docs/teaching/TeachingFlowContract.md) for automated coverage and manual acceptance limits.

The [teaching loop test ownership](../../../docs/teaching/TeachingLoopEngineeringSpec.md#test-simplification-and-retirement)
records the retired suites and replacements. Typed action/goal contracts, presenter receipts,
structured input history and scheduling have focused unit tests. The flow fixture owns
complete renderer → preload → main → worker → SDK → MCP journeys.
