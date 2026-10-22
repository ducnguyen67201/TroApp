import { expect, it, vi } from 'vitest';
import type { ApplicationAdapter } from './ApplicationAdapter.js';
import { getDefaultEvaluationScenario, getEvaluationTaskId } from './ScenarioCatalog.js';
import { WorkspaceStateSchema } from './InteractiveStudyWorkspace.js';
import {
  EvaluationPipelineStage,
  finalizeEvaluationTrial,
  prepareEvaluationTrial,
  runEvaluationStage,
  type EvaluationPipelineRecorder,
} from './RunEvaluationTrial.js';

function createFixture(application: 'vscode' | 'scratch') {
  const scenario = getDefaultEvaluationScenario(application);
  const state = WorkspaceStateSchema.parse({
    schemaVersion: 1,
    application,
    taskId: getEvaluationTaskId(scenario),
    trialId: 'TrialOne',
    saved: true,
    dropCompleted: false,
    projectTitle: 'Authored exercise',
    scrollConfirmed: false,
    scrollTop: 0,
    repeatCount: null,
    validationVisible: false,
    destination: null,
    ...(scenario.application === 'vscode' ? { pythonSource: scenario.fixture.source } : {}),
    trustedEvents: {
      click: 0,
      pointerDown: 0,
      pointerMove: 0,
      pointerUp: 0,
      input: 0,
      keyDown: 0,
      wheel: 0,
      drag: 0,
    },
    lastPointer: null,
    firstEffectElapsedMs: null,
    lastEffectElapsedMs: null,
    events: [],
    viewport: { width: 1, height: 1, devicePixelRatio: 1 },
    targets: [],
  });
  const adapter = {
    application,
    prepare: vi.fn<ApplicationAdapter['prepare']>().mockResolvedValue(undefined),
    observe: vi.fn<ApplicationAdapter['observe']>().mockResolvedValue(state),
    finalize: vi.fn<ApplicationAdapter['finalize']>().mockResolvedValue(undefined),
    grade: vi.fn<ApplicationAdapter['grade']>().mockReturnValue({
      passed: false,
      outcomeMatches: false,
      trustedInteractionObserved: false,
      reasons: ['authored_bug'],
    }),
    supportsOutcome: vi.fn<ApplicationAdapter['supportsOutcome']>().mockReturnValue(true),
    getNativeTarget: vi.fn<ApplicationAdapter['getNativeTarget']>().mockReturnValue(null),
    close: vi.fn<ApplicationAdapter['close']>().mockResolvedValue(undefined),
  } satisfies ApplicationAdapter;
  const record = vi.fn<EvaluationPipelineRecorder>().mockResolvedValue(undefined);
  return { scenario, state, adapter, record };
}

it.each(['vscode', 'scratch'] as const)(
  'prepares and verifies %s through the same internal lifecycle',
  async (application) => {
    const fixture = createFixture(application);
    await expect(
      prepareEvaluationTrial(fixture.adapter, fixture.scenario, 'TrialOne', fixture.record),
    ).resolves.toEqual(fixture.state);
    expect(fixture.adapter.prepare).toHaveBeenCalledWith(fixture.scenario, 'TrialOne');
    expect(fixture.record.mock.calls.map(([event]) => [event.stage, event.status])).toEqual([
      [EvaluationPipelineStage.PREPARE, 'passed'],
      [EvaluationPipelineStage.BASELINE, 'passed'],
    ]);
    await finalizeEvaluationTrial(fixture.adapter, 'TrialOne', fixture.record);
    expect(fixture.adapter.finalize).toHaveBeenCalledOnce();
    expect(fixture.record.mock.calls.at(-1)?.[0].stage).toBe(EvaluationPipelineStage.FINALIZE);
  },
);

it.each(['stale', 'unsupported', 'already_solved', 'wrong_source', 'wrong_application'])(
  'rejects an invalid baseline: %s',
  async (failure) => {
    const fixture = createFixture('vscode');
    if (failure === 'stale') {
      fixture.state.trialId = 'OtherTrial';
    }
    if (failure === 'unsupported') {
      fixture.adapter.supportsOutcome.mockReturnValue(false);
    }
    if (failure === 'already_solved') {
      fixture.adapter.grade.mockReturnValue({
        passed: true,
        outcomeMatches: true,
        trustedInteractionObserved: false,
        reasons: [],
      });
    }
    if (failure === 'wrong_source') {
      fixture.state.pythonSource = 'print("unrelated")';
    }
    if (failure === 'wrong_application') {
      fixture.state.application = 'scratch';
    }
    await expect(
      prepareEvaluationTrial(fixture.adapter, fixture.scenario, 'TrialOne', fixture.record),
    ).rejects.toThrow('evaluation_invalid_starting_state');
    expect(fixture.record.mock.calls.at(-1)?.[0]).toMatchObject({
      stage: EvaluationPipelineStage.BASELINE,
      status: 'failed',
    });
  },
);

it('records setup failure without running baseline observation', async () => {
  const fixture = createFixture('scratch');
  fixture.adapter.prepare.mockRejectedValue(new Error('page_unavailable'));
  await expect(
    prepareEvaluationTrial(fixture.adapter, fixture.scenario, 'TrialOne', fixture.record),
  ).rejects.toThrow('page_unavailable');
  expect(fixture.adapter.observe).not.toHaveBeenCalled();
  expect(fixture.record.mock.calls[0]?.[0]).toMatchObject({
    stage: EvaluationPipelineStage.PREPARE,
    status: 'failed',
  });
});

it('rejects a stale final export rather than grading another trial', async () => {
  const fixture = createFixture('scratch');
  fixture.state.trialId = 'PreviousTrial';
  await expect(
    finalizeEvaluationTrial(fixture.adapter, 'TrialOne', fixture.record),
  ).rejects.toThrow('evaluation_final_state_mismatch');
});

it('records bounded monotonic stage durations without retaining error contents', async () => {
  const record = vi.fn<EvaluationPipelineRecorder>().mockResolvedValue(undefined);
  const now = vi.fn<() => number>().mockReturnValueOnce(100).mockReturnValueOnce(125);
  await expect(
    runEvaluationStage(
      EvaluationPipelineStage.PREPARE,
      () => Promise.reject(new Error('private configuration')),
      record,
      now,
    ),
  ).rejects.toThrow('private configuration');
  expect(record).toHaveBeenCalledWith({
    stage: EvaluationPipelineStage.PREPARE,
    status: 'failed',
    elapsedMs: 25,
  });
});
