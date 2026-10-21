import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AgentTaskMode } from '../../../src/contracts/CursorCompanion.js';
import { ModelProfile } from '../../../src/contracts/ModelProfile.js';
import { InteractiveGatewayUrlSchema } from './InteractiveAgentProtocol.js';
import { EvaluationApplication } from './EvaluationApplication.js';
import { EvaluationScenarioSchema, type EvaluationScenario } from './EvaluationScenario.js';
import {
  getDefaultEvaluationScenario,
  getEvaluationTaskId,
  readEvaluationFixtureDigest,
} from './ScenarioCatalog.js';
import {
  InteractiveTaskId,
  createInteractiveCases,
  createWorkspaceHtml,
  type InteractiveCase,
} from './InteractiveStudyWorkspace.js';

export const InteractiveRunMode = { PREFLIGHT: 'preflight', LIVE: 'live' } as const;

export const InteractiveVariant = { OFF: 'ContextOff', ON: 'ContextOn' } as const;

const VariantSelection = { BOTH: 'both', OFF: 'off', ON: 'on' } as const;

export const InteractiveEvaluationLimits = {
  TRIAL_MS: 120_000,
  POLL_MS: 50,
  STOP_MS: 5000,
  MAXIMUM_BOOTSTRAP_BYTES: 16_384,
  APPLICATION_SETUP_MS: 120_000,
} as const;

export const InteractiveEvaluationConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runMode: z.enum(InteractiveRunMode),
    taskMode: z.enum(AgentTaskMode),
    application: z.enum(EvaluationApplication).default(EvaluationApplication.CONTROLLED),
    evaluationScenario: EvaluationScenarioSchema.nullable().default(null),
    singleRequest: z.boolean().default(false),
    request: z.string().trim().min(1).max(1200).nullable().default(null),
    repetitions: z.number().int().min(1).max(5),
    tasks: z.array(z.enum(InteractiveTaskId)).min(1).max(8),
    variants: z.array(z.enum(InteractiveVariant)).min(1).max(2),
    gatewayBaseUrl: InteractiveGatewayUrlSchema,
    dedicatedDesktopDeclared: z.boolean(),
  })
  .superRefine((config, context) => {
    if (config.evaluationScenario && config.evaluationScenario.application !== config.application) {
      context.addIssue({
        code: 'custom',
        message: 'The scenario and selected application must match.',
      });
    }
    if (
      config.application === EvaluationApplication.SCRATCH &&
      (!config.singleRequest ||
        config.tasks.length !== 1 ||
        config.tasks[0] !== InteractiveTaskId.DEBUG_SCORE)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The Scratch application currently supports the single debugging case.',
      });
    }
    if (
      (config.application === EvaluationApplication.VSCODE &&
        (!config.singleRequest ||
          config.tasks.length !== 1 ||
          config.tasks[0] !== InteractiveTaskId.DEBUG_PYTHON)) ||
      (config.application !== EvaluationApplication.VSCODE &&
        config.tasks.includes(InteractiveTaskId.DEBUG_PYTHON))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The customer Python debugging case requires the single VS Code application run.',
      });
    }
    if (
      (config.singleRequest &&
        (config.tasks.length !== 1 || config.variants.length !== 1 || config.repetitions !== 1)) ||
      (config.request !== null && !config.singleRequest)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A single request requires one task, variant and repetition.',
      });
    }
    if (
      new Set(config.tasks).size !== config.tasks.length ||
      new Set(config.variants).size !== config.variants.length
    ) {
      context.addIssue({ code: 'custom', message: 'Tasks and variants must be unique.' });
    }
    if (config.runMode === InteractiveRunMode.LIVE && !config.dedicatedDesktopDeclared) {
      context.addIssue({
        code: 'custom',
        message: 'Native runs require a dedicated test desktop. A test window is not containment.',
      });
    }
  });

export type InteractiveEvaluationConfig = z.infer<typeof InteractiveEvaluationConfigSchema>;

export interface InteractiveEvaluationOptions {
  config: InteractiveEvaluationConfig;
  credentialStdin: boolean;
  output: string | undefined;
  scenarioFile?: string;
}

export function parseInteractiveEvaluationOptions(args: string[]): InteractiveEvaluationOptions {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      live: { type: 'boolean', default: false },
      teach: { type: 'boolean', default: false },
      execute: { type: 'boolean', default: false },
      single: { type: 'boolean', default: false },
      request: { type: 'string' },
      application: { type: 'string', default: EvaluationApplication.CONTROLLED },
      'scenario-file': { type: 'string' },
      'dedicated-desktop': { type: 'boolean', default: false },
      'credential-stdin': { type: 'boolean', default: false },
      repetitions: { type: 'string' },
      task: { type: 'string' },
      variant: { type: 'string' },
      gateway: { type: 'string', default: 'http://127.0.0.1:3000/api/v1/model' },
      output: { type: 'string' },
    },
  });
  if (values.teach && values.execute) {
    throw new Error('Select teaching or execution, not both.');
  }
  const application = z.enum(EvaluationApplication).parse(values.application);
  if (values['scenario-file'] && application === EvaluationApplication.CONTROLLED) {
    throw new Error('A scenario file requires --application vscode or scratch.');
  }
  const singleRequest =
    values.single ||
    values.request !== undefined ||
    application !== EvaluationApplication.CONTROLLED;
  const variant = z.enum(VariantSelection).parse(values.variant ?? (singleRequest ? 'on' : 'both'));
  const config = InteractiveEvaluationConfigSchema.parse({
    schemaVersion: 1,
    application,
    runMode: values.live ? InteractiveRunMode.LIVE : InteractiveRunMode.PREFLIGHT,
    taskMode:
      values.teach || (singleRequest && !values.execute)
        ? AgentTaskMode.TEACH
        : AgentTaskMode.EXECUTE,
    singleRequest,
    request: values.request ?? null,
    repetitions: Number(values.repetitions ?? (singleRequest ? '1' : '3')),
    tasks: values.task
      ? values.task.split(',').map((task) => task.trim())
      : singleRequest
        ? [
            application === EvaluationApplication.VSCODE
              ? InteractiveTaskId.DEBUG_PYTHON
              : InteractiveTaskId.DEBUG_SCORE,
          ]
        : Object.values(InteractiveTaskId).filter(
            (task) =>
              task !== InteractiveTaskId.DEBUG_SCORE && task !== InteractiveTaskId.DEBUG_PYTHON,
          ),
    variants:
      variant === VariantSelection.BOTH
        ? Object.values(InteractiveVariant)
        : [variant === VariantSelection.ON ? InteractiveVariant.ON : InteractiveVariant.OFF],
    gatewayBaseUrl: values.gateway,
    dedicatedDesktopDeclared: values['dedicated-desktop'],
  });
  if (config.runMode === InteractiveRunMode.LIVE && !values['credential-stdin']) {
    throw new Error('A live run requires a short-lived gateway credential on stdin.');
  }
  if (config.runMode === InteractiveRunMode.PREFLIGHT && values['credential-stdin']) {
    throw new Error('Preflight does not accept or need a credential.');
  }
  return {
    config,
    credentialStdin: values['credential-stdin'],
    output: values.output,
    ...(values['scenario-file'] ? { scenarioFile: values['scenario-file'] } : {}),
  };
}

export interface InteractiveTrialPlan {
  scenario: InteractiveCase;
  caseId: string;
  evaluationScenario: EvaluationScenario | null;
  variant: InteractiveEvaluationConfig['variants'][number];
  repetition: number;
  pairId: string;
  startingStateId: string;
}

/** Reverse variant order across cases/repetitions; reset every trial. This controls
 * a technical comparison, not student assignment or instructional carryover. */
export function createInteractiveTrialPlan(
  configInput: InteractiveEvaluationConfig,
): InteractiveTrialPlan[] {
  const config = InteractiveEvaluationConfigSchema.parse(configInput);
  const trials: InteractiveTrialPlan[] = [];
  const definition =
    config.application === EvaluationApplication.CONTROLLED
      ? null
      : (config.evaluationScenario ?? getDefaultEvaluationScenario(config.application));
  for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
    const cases = createInteractiveCases(repetition)
      .filter((scenario) => config.tasks.includes(scenario.id))
      .map((scenario) =>
        definition && scenario.id === getEvaluationTaskId(definition)
          ? {
              ...scenario,
              title: definition.title,
              request: config.request ?? definition.request,
              historyText: definition.historyText,
              locale: definition.locale,
            }
          : config.request === null
            ? scenario
            : { ...scenario, request: config.request },
      );
    for (const [index, scenario] of cases.entries()) {
      const variants =
        (repetition + index) % 2 === 0 ? [...config.variants].reverse() : config.variants;
      const startingStateId = createHash('sha256')
        .update(
          JSON.stringify({
            scenario,
            mode: config.taskMode,
            model: ModelProfile.MAIN,
            application: config.application,
            definition,
            fixture: definition
              ? readEvaluationFixtureDigest(definition)
              : createWorkspaceHtml({ taskId: scenario.id, trialId: 'ComparisonIdentity' }),
          }),
        )
        .digest('hex');
      for (const variant of variants) {
        trials.push({
          scenario,
          caseId: definition?.id ?? scenario.id,
          evaluationScenario: definition,
          variant,
          repetition,
          pairId: `${definition?.id ?? scenario.id}Repeat${String(repetition)}`,
          startingStateId,
        });
      }
    }
  }
  return trials;
}
