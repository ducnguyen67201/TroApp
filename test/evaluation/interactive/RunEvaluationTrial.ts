import type { ApplicationAdapter } from './ApplicationAdapter.js';
import type { EvaluationScenario } from './EvaluationScenario.js';
import { getEvaluationTaskId } from './ScenarioCatalog.js';
import type { WorkspaceState } from './InteractiveStudyWorkspace.js';

export const EvaluationPipelineStage = {
  PREPARE: 'prepare_environment',
  BASELINE: 'verify_starting_state',
  NATIVE_READY: 'verify_native_window',
  AGENT: 'run_tro_agent',
  FINALIZE: 'read_final_application_state',
  CLEANUP: 'close_environment',
} as const;

export const EvaluationPipelineStatus = { PASSED: 'passed', FAILED: 'failed' } as const;

export interface EvaluationPipelineEvent {
  stage: (typeof EvaluationPipelineStage)[keyof typeof EvaluationPipelineStage];
  status: (typeof EvaluationPipelineStatus)[keyof typeof EvaluationPipelineStatus];
  elapsedMs: number;
}

export type EvaluationPipelineRecorder = (event: EvaluationPipelineEvent) => Promise<void>;

/** Internal application lifecycle shared by Python and Scratch. Events contain
 * stage/timing metadata only; the explicit trial recorder owns authored content. */
export async function runEvaluationStage<Result>(
  stage: EvaluationPipelineEvent['stage'],
  operation: () => Promise<Result>,
  record: EvaluationPipelineRecorder,
  now: () => number = () => performance.now(),
): Promise<Result> {
  const startedAt = now();
  let result: Result;
  try {
    result = await operation();
  } catch (error: unknown) {
    await record({
      stage,
      status: EvaluationPipelineStatus.FAILED,
      elapsedMs: Math.max(0, now() - startedAt),
    });
    throw error;
  }
  await record({
    stage,
    status: EvaluationPipelineStatus.PASSED,
    elapsedMs: Math.max(0, now() - startedAt),
  });
  return result;
}

export async function prepareEvaluationTrial(
  adapter: ApplicationAdapter,
  scenario: EvaluationScenario,
  trialId: string,
  record: EvaluationPipelineRecorder,
): Promise<WorkspaceState> {
  await runEvaluationStage(
    EvaluationPipelineStage.PREPARE,
    () => adapter.prepare(scenario, trialId),
    record,
  );
  return runEvaluationStage(
    EvaluationPipelineStage.BASELINE,
    async () => {
      const state = await adapter.observe();
      if (
        state.trialId !== trialId ||
        state.taskId !== getEvaluationTaskId(scenario) ||
        state.application !== scenario.application ||
        !adapter.supportsOutcome() ||
        adapter.grade(state, trialId).outcomeMatches ||
        (scenario.application === 'vscode' && state.pythonSource !== scenario.fixture.source)
      ) {
        throw new Error('evaluation_invalid_starting_state');
      }
      return state;
    },
    record,
  );
}

export async function finalizeEvaluationTrial(
  adapter: ApplicationAdapter,
  trialId: string,
  record: EvaluationPipelineRecorder,
): Promise<WorkspaceState> {
  return runEvaluationStage(
    EvaluationPipelineStage.FINALIZE,
    async () => {
      await adapter.finalize();
      const state = await adapter.observe();
      if (state.trialId !== trialId) {
        throw new Error('evaluation_final_state_mismatch');
      }
      return state;
    },
    record,
  );
}
