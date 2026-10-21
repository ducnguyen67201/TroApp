import { describe, expect, it } from 'vitest';
import { AgentTaskMode } from '../../../src/contracts/CursorCompanion.js';
import {
  InteractiveEvaluationConfigSchema,
  InteractiveRunMode,
  InteractiveVariant,
  createInteractiveTrialPlan,
  parseInteractiveEvaluationOptions,
} from './InteractiveEvaluationConfig.js';
import { InteractiveTaskId } from './InteractiveStudyWorkspace.js';
import { EvaluationApplication } from './EvaluationApplication.js';
import { DesktopLocale } from '../../../src/contracts/DesktopLocale.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';

describe('interactive evaluation matrix', () => {
  it('uses manifest identity and request without changing the application task selector', () => {
    const { config } = parseInteractiveEvaluationOptions([
      '--application',
      'vscode',
      '--scenario-file',
      'Scenario.json',
    ]);
    const definition = getDefaultEvaluationScenario('vscode');
    definition.id = 'MyInternalDebugCase';
    definition.request = 'Help me debug my guessing game.';
    const plan = createInteractiveTrialPlan({ ...config, evaluationScenario: definition });
    expect(plan[0]?.caseId).toBe('MyInternalDebugCase');
    expect(plan[0]?.scenario.id).toBe(InteractiveTaskId.DEBUG_PYTHON);
    expect(plan[0]?.scenario.request).toBe(definition.request);
    expect(plan[0]?.evaluationScenario).toEqual(definition);
    expect(() =>
      InteractiveEvaluationConfigSchema.parse({
        ...config,
        evaluationScenario: getDefaultEvaluationScenario('scratch'),
      }),
    ).toThrow();
    expect(() => parseInteractiveEvaluationOptions(['--scenario-file', 'Scenario.json'])).toThrow();
  });
  it('selects one Vietnamese customer Python case in the actual VS Code application', () => {
    const { config } = parseInteractiveEvaluationOptions(['--application', 'vscode']);
    const plan = createInteractiveTrialPlan(config);
    expect(config.application).toBe(EvaluationApplication.VSCODE);
    expect(config.singleRequest).toBe(true);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.scenario).toMatchObject({
      id: InteractiveTaskId.DEBUG_PYTHON,
      locale: DesktopLocale.VIETNAMESE,
    });
    expect(() =>
      parseInteractiveEvaluationOptions(['--application', 'vscode', '--task', 'DebugScore']),
    ).toThrow();
    expect(() =>
      parseInteractiveEvaluationOptions(['--single', '--task', 'DebugPython']),
    ).toThrow();
  });
  it('selects the actual Scratch web editor explicitly without expanding the trial count', () => {
    const { config } = parseInteractiveEvaluationOptions(['--application', 'scratch']);
    expect(config.application).toBe(EvaluationApplication.SCRATCH);
    expect(config.singleRequest).toBe(true);
    expect(createInteractiveTrialPlan(config)).toHaveLength(1);
    expect(createInteractiveTrialPlan(config)[0]?.scenario.id).toBe(InteractiveTaskId.DEBUG_SCORE);
    expect(() =>
      parseInteractiveEvaluationOptions(['--application', 'scratch', '--task', 'Click']),
    ).toThrow();
  });
  it('defaults to 36 planned trials without authorizing a live desktop run', () => {
    const options = parseInteractiveEvaluationOptions([]);
    expect(options).toMatchObject({
      credentialStdin: false,
      output: undefined,
      config: {
        runMode: InteractiveRunMode.PREFLIGHT,
        taskMode: AgentTaskMode.EXECUTE,
        repetitions: 3,
        tasks: Object.values(InteractiveTaskId).filter(
          (task) =>
            task !== InteractiveTaskId.DEBUG_SCORE && task !== InteractiveTaskId.DEBUG_PYTHON,
        ),
        variants: [InteractiveVariant.OFF, InteractiveVariant.ON],
        dedicatedDesktopDeclared: false,
      },
    });
    expect(createInteractiveTrialPlan(options.config)).toHaveLength(36);
  });

  it('pairs identical requests, history and starting conditions across context variants', () => {
    const { config } = parseInteractiveEvaluationOptions([]);
    const trials = createInteractiveTrialPlan(config);
    const pairIds = new Set(trials.map((trial) => trial.pairId));
    expect(pairIds.size).toBe(18);
    for (const pairId of pairIds) {
      const pair = trials.filter((trial) => trial.pairId === pairId);
      expect(pair).toHaveLength(2);
      const [first, second] = pair;
      if (!first || !second) {
        throw new Error('Missing paired interactive trial.');
      }
      expect(new Set(pair.map((trial) => trial.variant))).toEqual(
        new Set([InteractiveVariant.OFF, InteractiveVariant.ON]),
      );
      expect(first.scenario).toEqual(second.scenario);
      expect(first.scenario.request).toBe(second.scenario.request);
      expect(first.scenario.historyText).toBe(second.scenario.historyText);
      expect(first.startingStateId).toBe(second.startingStateId);
      expect(first.startingStateId).toMatch(/^[a-f0-9]{64}$/);
      expect(first.repetition).toBe(second.repetition);
    }
    expect(createInteractiveTrialPlan(config)).toEqual(trials);
  });

  it('counterbalances variant order across neighboring cases and repetitions', () => {
    const { config } = parseInteractiveEvaluationOptions([]);
    const trials = createInteractiveTrialPlan(config);
    const order = (
      taskId: typeof InteractiveTaskId.CLICK | typeof InteractiveTaskId.DRAG,
      repetition: number,
    ) =>
      trials
        .filter((trial) => trial.scenario.id === taskId && trial.repetition === repetition)
        .map((trial) => trial.variant);
    expect(order(InteractiveTaskId.CLICK, 1)).toEqual([
      InteractiveVariant.OFF,
      InteractiveVariant.ON,
    ]);
    expect(order(InteractiveTaskId.CLICK, 2)).toEqual([
      InteractiveVariant.ON,
      InteractiveVariant.OFF,
    ]);
    expect(order(InteractiveTaskId.DRAG, 1)).toEqual([
      InteractiveVariant.ON,
      InteractiveVariant.OFF,
    ]);
  });

  it('supports forwarded task, variant and repetition filters', () => {
    const options = parseInteractiveEvaluationOptions([
      '--',
      '--task',
      'Click, Drag',
      '--variant',
      'on',
      '--repetitions',
      '2',
      '--output',
      'EvaluationOutput',
    ]);
    const trials = createInteractiveTrialPlan(options.config);
    expect(options.output).toBe('EvaluationOutput');
    expect(trials).toHaveLength(4);
    expect(new Set(trials.map((trial) => trial.scenario.id))).toEqual(
      new Set([InteractiveTaskId.CLICK, InteractiveTaskId.DRAG]),
    );
    expect(trials.every((trial) => trial.variant === InteractiveVariant.ON)).toBe(true);
    expect(new Set(trials.map((trial) => trial.repetition))).toEqual(new Set([1, 2]));
  });

  it('records teaching mode as a different starting-condition identity', () => {
    const execute = parseInteractiveEvaluationOptions(['--task', 'Click', '--repetitions', '1']);
    const teach = parseInteractiveEvaluationOptions([
      '--teach',
      '--task',
      'Click',
      '--repetitions',
      '1',
    ]);
    expect(teach.config.taskMode).toBe(AgentTaskMode.TEACH);
    const executeIds = createInteractiveTrialPlan(execute.config).map(
      (trial) => trial.startingStateId,
    );
    const teachIds = createInteractiveTrialPlan(teach.config).map((trial) => trial.startingStateId);
    expect(teachIds).not.toEqual(executeIds);
  });

  it('selects exactly one natural debugging request and production teaching by default', () => {
    const { config } = parseInteractiveEvaluationOptions(['--single']);
    expect(config).toMatchObject({
      singleRequest: true,
      repetitions: 1,
      taskMode: AgentTaskMode.TEACH,
      tasks: [InteractiveTaskId.DEBUG_SCORE],
      variants: [InteractiveVariant.ON],
      runMode: InteractiveRunMode.PREFLIGHT,
    });
    const plan = createInteractiveTrialPlan(config);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.scenario.request).toContain('debug');
    expect(plan[0]?.scenario.historyText).not.toContain('outside');
  });

  it('accepts one custom request and preserves the independent fixture rubric for separate diagnostics', () => {
    const request = 'Please explain why my score stays at one.';
    const { config } = parseInteractiveEvaluationOptions(['--request', request]);
    expect(config.singleRequest).toBe(true);
    expect(createInteractiveTrialPlan(config)[0]?.scenario.request).toBe(request);
    expect(createInteractiveTrialPlan(config)[0]?.scenario.expectedState.scoreAfterThreeTurns).toBe(
      3,
    );
  });

  it.each([
    ['--single', '--variant', 'both'],
    ['--single', '--repetitions', '2'],
    ['--single', '--task', 'Click,Drag'],
    ['--single', '--teach', '--execute'],
  ])('rejects expanding one request into multiple runs: %j', (...args) => {
    expect(() => parseInteractiveEvaluationOptions(args)).toThrow();
  });
});

describe('interactive evaluation prerequisites', () => {
  it('requires both a dedicated desktop declaration and credential input for live mode', () => {
    expect(() => parseInteractiveEvaluationOptions(['--live', '--credential-stdin'])).toThrow(
      'dedicated',
    );
    expect(() => parseInteractiveEvaluationOptions(['--live', '--dedicated-desktop'])).toThrow(
      'credential',
    );
    expect(
      parseInteractiveEvaluationOptions(['--live', '--dedicated-desktop', '--credential-stdin']),
    ).toMatchObject({
      credentialStdin: true,
      config: { runMode: InteractiveRunMode.LIVE, dedicatedDesktopDeclared: true },
    });
  });

  it('rejects credential input for preflight', () => {
    expect(() => parseInteractiveEvaluationOptions(['--credential-stdin'])).toThrow('Preflight');
  });

  it.each([
    ['--repetitions', '0'],
    ['--repetitions', '6'],
    ['--repetitions', 'invalid'],
    ['--task', 'Click,Click'],
    ['--task', 'UnknownTask'],
    ['--variant', 'unknown'],
  ])('rejects invalid selection %j', (...args) => {
    expect(() => parseInteractiveEvaluationOptions(args)).toThrow();
  });

  it('rejects duplicate variants at the validated configuration boundary', () => {
    const { config } = parseInteractiveEvaluationOptions([]);
    expect(
      InteractiveEvaluationConfigSchema.safeParse({
        ...config,
        variants: [InteractiveVariant.ON, InteractiveVariant.ON],
      }).success,
    ).toBe(false);
  });

  it.each([
    'http://gateway.example/api/v1/model',
    'https://user:password@gateway.example/api/v1/model',
    'https://gateway.example/api/v1/model?token=synthetic',
    'https://gateway.example/api/v1/model#fragment',
  ])('rejects a gateway URL unsuitable for scoped credentials: %s', (gateway) => {
    expect(() => parseInteractiveEvaluationOptions(['--gateway', gateway])).toThrow();
  });

  it.each([
    'http://127.0.0.1:3000/api/v1/model',
    'http://localhost:3000/api/v1/model',
    'https://gateway.example/api/v1/model',
  ])('accepts an HTTPS or local HTTP gateway: %s', (gateway) => {
    expect(parseInteractiveEvaluationOptions(['--gateway', gateway]).config.gatewayBaseUrl).toBe(
      gateway,
    );
  });
});
