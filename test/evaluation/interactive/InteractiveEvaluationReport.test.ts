import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ModelProfile } from '../../../src/contracts/ModelProfile.js';
import { CompletionMode, TaskOutcomeStatus } from '../../../src/contracts/TaskOutcome.js';
import {
  InteractiveAgentMessageKind,
  type InteractiveAgentSettled,
} from './InteractiveAgentProtocol.js';
import {
  InteractiveRunMode,
  InteractiveVariant,
  parseInteractiveEvaluationOptions,
} from './InteractiveEvaluationConfig.js';
import {
  InteractiveReportOutcome,
  InteractiveTrialStatus,
  formatInteractiveEvaluationReport,
  summarizeInteractiveAgent,
  summarizeInteractiveAccounting,
  summarizeInteractivePairs,
  summarizeInteractiveResults,
  type InteractiveEvaluationReport,
  type InteractiveTrialResult,
} from './InteractiveEvaluationReport.js';
import { InteractiveTaskId } from './InteractiveStudyWorkspace.js';
import { EvaluationPriceCardSchema } from '../accounting/EvaluationUsage.js';

function createAgentResult(
  result: InteractiveAgentSettled['result'] = {
    kind: 'completed',
    answer: 'The authored task is complete.',
    completion: { kind: CompletionMode.RESPONSE },
  },
): InteractiveAgentSettled {
  return {
    kind: InteractiveAgentMessageKind.SETTLED,
    trialId: randomUUID(),
    result,
    failed: false,
    durationMs: 900,
    contextPreparationMs: null,
    modelRequests: [],
    toolCalls: 3,
    mutationCalls: 1,
    outputCount: 0,
    studentInputCalls: null,
  };
}

function createTrial(overrides: Partial<InteractiveTrialResult> = {}): InteractiveTrialResult {
  return {
    trialId: randomUUID(),
    scenarioId: InteractiveTaskId.CLICK,
    variant: InteractiveVariant.OFF,
    repetition: 1,
    pairId: 'ClickRepeat1',
    startingStateId: 'AuthoredStartingState',
    status: InteractiveTrialStatus.SETTLED,
    outcomePassed: true,
    reasons: [],
    taskDurationMs: 1000,
    firstObservedInputMs: 300,
    firstVerifiedOutcomeMs: 600,
    cueAcknowledgedMs: null,
    cursorMoved: true,
    maximumCursorDistanceDip: 300,
    finalCursorDip: { x: 500, y: 400 },
    observedInput: {
      click: 1,
      pointerDown: 1,
      pointerMove: 1,
      pointerUp: 1,
      input: 0,
      keyDown: 0,
      wheel: 0,
      drag: 0,
    },
    events: [],
    geometry: {
      viewport: { width: 1120, height: 820, devicePixelRatio: 2 },
      targets: [
        { id: 'SaveCard', label: 'Save card', bounds: { x: 100, y: 100, width: 120, height: 40 } },
      ],
      lastPointerCss: { x: 150, y: 120 },
      windowContentDip: { x: 20, y: 40, width: 1120, height: 820 },
    },
    agent: summarizeInteractiveAgent(createAgentResult()),
    ...overrides,
  };
}

function createReport(
  trials: InteractiveTrialResult[] = [],
  runMode: InteractiveEvaluationReport['runMode'] = InteractiveRunMode.LIVE,
): InteractiveEvaluationReport {
  const config = parseInteractiveEvaluationOptions([]).config;
  return {
    schemaVersion: 1,
    runMode,
    config: { ...config, runMode, dedicatedDesktopDeclared: runMode === InteractiveRunMode.LIVE },
    model: ModelProfile.MAIN,
    generatedAt: '2026-10-21T12:00:00.000Z',
    applicationRevision: 'AuthoredFixtureRevision',
    expectedTrials: 36,
    trials,
    preflight: [],
    interrupted: false,
    stopReason: null,
    outcome:
      runMode === InteractiveRunMode.PREFLIGHT
        ? InteractiveReportOutcome.PREFLIGHT_PASSED
        : InteractiveReportOutcome.FINISHED,
    audioLatencyMeasured: false,
    visiblePixelsVerified: false,
    studentLearningMeasured: false,
    contextSource: 'authored_fixture',
    providerAttemptAccountingComplete: false,
  };
}

it('describes saved-source VS Code preflight without claiming rendered UI or Python execution', () => {
  const report = createReport([], InteractiveRunMode.PREFLIGHT);
  report.config = parseInteractiveEvaluationOptions(['--application', 'vscode']).config;
  const text = formatInteractiveEvaluationReport(report);
  expect(text).toContain('actual installed VS Code');
  expect(text).toContain('authored paraphrase');
  expect(text).toContain('does not execute Python');
  expect(text).toContain('readiness are not independently observed');
  expect(text).toContain('ProgramOutcome.md');
});

it('keeps fixture preflight distinct from model, cursor and learning measurements', () => {
  const report = createReport([], InteractiveRunMode.PREFLIGHT);
  report.preflight.push({
    scenarioId: InteractiveTaskId.CLICK,
    rendered: true,
    targets: 1,
    initialOutcomePassed: false,
  });
  expect(summarizeInteractiveResults(report).every((summary) => summary.successful === 0)).toBe(
    true,
  );
  const markdown = formatInteractiveEvaluationReport(report);
  expect(markdown).toContain('Preflight only');
  expect(markdown).toContain(
    'No model request, native input, cursor motion or teaching success was measured',
  );
  expect(markdown).toContain('No student learning was assessed');
  expect(markdown).toContain('unmeasured');
});

it('does not promote changed app state after a timeout or failure into a successful trial', () => {
  const report = createReport([
    createTrial({ status: InteractiveTrialStatus.TIMED_OUT }),
    createTrial({ status: InteractiveTrialStatus.FAILED, repetition: 2, pairId: 'ClickRepeat2' }),
  ]);
  expect(
    summarizeInteractiveResults(report).find(
      (summary) => summary.variant === InteractiveVariant.OFF,
    ),
  ).toMatchObject({ trials: 2, successful: 0, outcomePassed: 2, timeouts: 1, failed: 1 });
});

it('compares matched app outcomes without replacing them with model completion claims', () => {
  const report = createReport([
    createTrial({ outcomePassed: false }),
    createTrial({ variant: InteractiveVariant.ON }),
    createTrial({ pairId: 'SecondPair', repetition: 2 }),
    createTrial({
      pairId: 'SecondPair',
      repetition: 2,
      variant: InteractiveVariant.ON,
      outcomePassed: false,
    }),
    createTrial({ pairId: 'BothPassed', repetition: 3 }),
    createTrial({ pairId: 'BothPassed', repetition: 3, variant: InteractiveVariant.ON }),
    createTrial({ pairId: 'NeitherPassed', repetition: 4, outcomePassed: false }),
    createTrial({
      pairId: 'NeitherPassed',
      repetition: 4,
      variant: InteractiveVariant.ON,
      status: InteractiveTrialStatus.TIMED_OUT,
    }),
  ]);
  expect(summarizeInteractivePairs(report)).toEqual({
    contextOnWins: 1,
    contextOffWins: 1,
    bothPassed: 1,
    neitherPassed: 1,
    unmatchedTrials: 0,
  });
});

it('excludes different starting states, different cases and duplicate variants from paired wins', () => {
  const report = createReport([
    createTrial(),
    createTrial({ variant: InteractiveVariant.ON, startingStateId: 'DifferentHistory' }),
    createTrial({ pairId: 'DifferentCases' }),
    createTrial({
      pairId: 'DifferentCases',
      variant: InteractiveVariant.ON,
      scenarioId: InteractiveTaskId.DRAG,
    }),
    createTrial({ pairId: 'DuplicateVariants' }),
    createTrial({ pairId: 'DuplicateVariants' }),
    createTrial({ pairId: 'DuplicateVariants', variant: InteractiveVariant.ON }),
  ]);
  expect(summarizeInteractivePairs(report)).toEqual({
    contextOnWins: 0,
    contextOffWins: 0,
    bothPassed: 0,
    neitherPassed: 0,
    unmatchedTrials: 7,
  });
});

it('distinguishes observed token subtotals, unknown request usage and absent accounting', () => {
  const measuredAgent = createAgentResult();
  measuredAgent.modelRequests = [
    {
      id: randomUUID(),
      status: 200,
      durationMs: 100,
      inputTokens: 200,
      cachedInputTokens: 30,
      outputTokens: 10,
    },
    {
      id: randomUUID(),
      status: 502,
      durationMs: 200,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
    },
  ];
  const report = createReport([
    createTrial({ agent: summarizeInteractiveAgent(measuredAgent) }),
    createTrial({ pairId: 'UnknownAccounting', repetition: 2, agent: null }),
  ]);
  expect(
    summarizeInteractiveResults(report).find(
      (summary) => summary.variant === InteractiveVariant.OFF,
    ),
  ).toMatchObject({
    gatewayRequests: 2,
    requestsWithUnknownUsage: 1,
    trialsWithoutAccounting: 1,
    inputTokensObserved: 200,
    outputTokensObserved: 10,
  });
  const markdown = formatInteractiveEvaluationReport(report);
  expect(markdown).toContain('Trials without accounting');
  expect(markdown).toContain('not complete provider-attempt accounting');
  expect(markdown).toContain('prices remain unknown');
});

it('prices observed calls per trial and run without treating missing worker accounting as free', () => {
  const measured = createAgentResult();
  measured.modelRequests = [
    {
      id: randomUUID(),
      status: 200,
      durationMs: 100,
      model: 'synthetic-model',
      inputTokens: 1000,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 100,
    },
  ];
  const report = createReport([createTrial({ agent: summarizeInteractiveAgent(measured) })]);
  report.config.pricing = EvaluationPriceCardSchema.parse({
    schemaVersion: 1,
    currency: 'USD',
    id: 'SyntheticRateCard',
    source: 'Authored test prices, not a provider quote',
    effectiveAt: '2026-10-21T00:00:00.000Z',
    models: [
      {
        model: 'synthetic-model',
        missingCacheWriteTokens: 'unknown',
        tiers: [
          {
            maximumInputTokens: null,
            inputUsdPerMillion: 2,
            cachedInputUsdPerMillion: 0.1,
            cacheWriteInputUsdPerMillion: 2.5,
            outputUsdPerMillion: 10,
          },
        ],
      },
    ],
  });
  const usage = summarizeInteractiveAccounting(report);
  expect(usage).toMatchObject({
    gatewayCalls: 1,
    inputTokensObserved: 1000,
    outputTokensObserved: 300,
    reasoningTokensObserved: 100,
    estimatedCostUsd: 0.00467,
    knownEstimatedCostUsd: 0.00467,
    unpricedCalls: 0,
  });
  const markdown = formatInteractiveEvaluationReport(report);
  expect(markdown).toContain('$0.004670');
  expect(markdown).toContain('SyntheticRateCard');
  expect(markdown).toContain('synthetic-model');
  report.trials.push(createTrial({ agent: null, repetition: 2 }));
  expect(summarizeInteractiveAccounting(report)).toMatchObject({
    gatewayCalls: 1,
    estimatedCostUsd: null,
    knownEstimatedCostUsd: 0.00467,
    trialsWithoutAccounting: 1,
  });
  expect(formatInteractiveEvaluationReport(report)).toContain(
    'Missing trial accounting keeps the run estimate unknown',
  );
});

it('distinguishes a provider-free preflight from a live run with missing accounting', () => {
  expect(
    summarizeInteractiveAccounting(createReport([], InteractiveRunMode.PREFLIGHT)),
  ).toMatchObject({
    gatewayCalls: 0,
    inputTokensObserved: 0,
    outputTokensObserved: 0,
    estimatedCostUsd: 0,
  });
  expect(summarizeInteractiveAccounting(createReport([], InteractiveRunMode.LIVE))).toMatchObject({
    gatewayCalls: null,
    inputTokensObserved: null,
    estimatedCostUsd: null,
  });
});

it('leaves missing timing spans unmeasured and reports sample counts for observed spans', () => {
  const report = createReport([
    createTrial(),
    createTrial({
      pairId: 'MissingTiming',
      repetition: 2,
      firstObservedInputMs: null,
      firstVerifiedOutcomeMs: null,
    }),
  ]);
  expect(
    summarizeInteractiveResults(report).find(
      (summary) => summary.variant === InteractiveVariant.OFF,
    ),
  ).toMatchObject({
    firstObservedInput: { samples: 1, p50Ms: 300, p95Ms: 300 },
    firstVerifiedOutcome: { samples: 1, p50Ms: 600, p95Ms: 600 },
    cueAcknowledged: { samples: 0, p50Ms: null, p95Ms: null },
  });
});

it('retains completion status while dropping model answer and limitation text', () => {
  const agent = createAgentResult({
    kind: 'completed',
    answer: 'PrivateModelAnswerMustNotAppear',
    completion: {
      kind: CompletionMode.TASK,
      outcome: {
        status: TaskOutcomeStatus.BLOCKED,
        requiredCriteriaCount: 1,
        supportedCriteriaCount: 0,
        remainingCriteriaCount: 1,
        limitation: 'PrivateModelLimitationMustNotAppear',
      },
    },
  });
  const summary = summarizeInteractiveAgent(agent);
  expect(summary).toMatchObject({
    resultKind: 'completed',
    completionMode: CompletionMode.TASK,
    taskOutcomeStatus: TaskOutcomeStatus.BLOCKED,
  });
  expect(summary).not.toHaveProperty('result');
  expect(JSON.stringify(summary)).not.toContain('PrivateModel');
  expect(JSON.stringify(createReport([createTrial({ agent: summary })]))).not.toContain(
    'PrivateModel',
  );
});

it('keeps response-only clarification separate from task success without persisting its text', () => {
  const summary = summarizeInteractiveAgent(
    createAgentResult({
      kind: 'completed',
      answer: 'PrivateClarificationQuestionMustNotAppear',
      completion: { kind: CompletionMode.RESPONSE },
    }),
  );
  expect(summary).toMatchObject({
    completionMode: CompletionMode.RESPONSE,
    taskOutcomeStatus: null,
  });
  const report = createReport([
    createTrial({ scenarioId: InteractiveTaskId.HISTORY, outcomePassed: false, agent: summary }),
  ]);
  const markdown = formatInteractiveEvaluationReport(report);
  expect(markdown).toContain('Asking for clarification is appropriate');
  expect(markdown).not.toContain('PrivateClarification');
  expect(
    summarizeInteractiveResults(report).find((item) => item.variant === InteractiveVariant.OFF)
      ?.successful,
  ).toBe(0);
});

it('drops raw failed messages and leaves non-completion metadata null', () => {
  const summary = summarizeInteractiveAgent(
    createAgentResult({ kind: 'failed', message: 'PrivateFailureDetailsMustNotAppear' }),
  );
  expect(summary).toMatchObject({
    resultKind: 'failed',
    completionMode: null,
    taskOutcomeStatus: null,
  });
  expect(JSON.stringify(summary)).not.toContain('PrivateFailure');
});
