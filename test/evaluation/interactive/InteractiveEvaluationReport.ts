import type { InteractiveAgentSettled } from './InteractiveAgentProtocol.js';
import type {
  InteractiveEvaluationConfig,
  InteractiveTrialPlan,
} from './InteractiveEvaluationConfig.js';
import { InteractiveRunMode, InteractiveVariant } from './InteractiveEvaluationConfig.js';
import type { WorkspaceState } from './InteractiveStudyWorkspace.js';
import { CompletionMode, type TaskOutcome } from '../../../src/contracts/TaskOutcome.js';
import { AgentTaskMode, type TeachingOutcome } from '../../../src/contracts/CursorCompanion.js';
import type { AgentRequestChecklist } from './GradeAgentRequest.js';
import type { AgentRequestRecordingSummary } from './RecordAgentRequest.js';
import { EvaluationApplication } from './EvaluationApplication.js';
import {
  formatEvaluationUsage,
  summarizeEvaluationUsage,
  type EvaluationUsageSummary,
} from '../accounting/EvaluationUsage.js';

export const InteractiveTrialStatus = {
  SETTLED: 'settled',
  TIMED_OUT: 'timed_out',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export const InteractiveReportOutcome = {
  PREFLIGHT_PASSED: 'preflight_passed',
  FINISHED: 'finished',
  INCOMPLETE: 'incomplete',
} as const;

export type InteractiveAgentSummary = Omit<InteractiveAgentSettled, 'result'> & {
  resultKind: NonNullable<InteractiveAgentSettled['result']>['kind'] | null;
  completionMode: (typeof CompletionMode)[keyof typeof CompletionMode] | null;
  taskOutcomeStatus: TaskOutcome['status'] | null;
  teachingOutcome: TeachingOutcome | null;
};

/** Task summaries omit answer text; explicit per-trial recordings own public outputs. */
export function summarizeInteractiveAgent(
  result: InteractiveAgentSettled,
): InteractiveAgentSummary {
  const { result: agentResult, ...measurements } = result;
  const completion = agentResult?.kind === 'completed' ? agentResult.completion : null;
  return {
    ...measurements,
    resultKind: agentResult?.kind ?? null,
    completionMode: completion?.kind ?? null,
    taskOutcomeStatus: completion?.kind === CompletionMode.TASK ? completion.outcome.status : null,
    teachingOutcome: agentResult?.kind === 'teaching' ? agentResult.result.outcome : null,
  };
}

export interface InteractiveTrialResult {
  trialId: string;
  scenarioId: string;
  variant: InteractiveTrialPlan['variant'];
  repetition: number;
  pairId: string;
  startingStateId: string;
  status: (typeof InteractiveTrialStatus)[keyof typeof InteractiveTrialStatus];
  outcomePassed: boolean;
  reasons: string[];
  taskDurationMs: number;
  firstObservedInputMs: number | null;
  firstVerifiedOutcomeMs: number | null;
  cueAcknowledgedMs: number | null;
  cursorMoved: boolean;
  maximumCursorDistanceDip: number;
  finalCursorDip: { x: number; y: number };
  observedInput: WorkspaceState['trustedEvents'];
  events: WorkspaceState['events'];
  geometry: {
    viewport: WorkspaceState['viewport'];
    targets: WorkspaceState['targets'];
    lastPointerCss: WorkspaceState['lastPointer'];
    windowContentDip: { x: number; y: number; width: number; height: number };
  };
  agent: InteractiveAgentSummary | null;
  requestEvaluation?: AgentRequestChecklist;
  recording?: AgentRequestRecordingSummary;
  accounting?: EvaluationUsageSummary;
}

export interface InteractivePreflightResult {
  scenarioId: string;
  rendered: boolean;
  targets: number;
  initialOutcomePassed: boolean;
}

export interface InteractiveEvaluationReport {
  schemaVersion: 1;
  runMode: InteractiveEvaluationConfig['runMode'];
  config: InteractiveEvaluationConfig;
  model: string;
  generatedAt: string;
  applicationRevision: string | null;
  expectedTrials: number;
  trials: InteractiveTrialResult[];
  preflight: InteractivePreflightResult[];
  interrupted: boolean;
  stopReason: string | null;
  outcome: (typeof InteractiveReportOutcome)[keyof typeof InteractiveReportOutcome];
  audioLatencyMeasured: false;
  visiblePixelsVerified: false;
  studentLearningMeasured: false;
  contextSource: 'authored_fixture';
  providerAttemptAccountingComplete: false;
  accounting?: InteractiveUsageSummary;
  usageByVariant?: {
    variant: InteractiveTrialPlan['variant'];
    accounting: InteractiveUsageSummary;
  }[];
}

export interface InteractiveUsageSummary extends EvaluationUsageSummary {
  trialsWithoutAccounting: number;
}

/** Aggregate finalized trial observations. A missing worker result can hide paid
 * calls; its absence must not turn an observed subtotal into a complete total. */
export function summarizeInteractiveAccounting(
  report: InteractiveEvaluationReport,
  trials: readonly InteractiveTrialResult[] = report.trials,
): InteractiveUsageSummary {
  const trialsWithoutAccounting = trials.filter((trial) => trial.agent === null).length;
  const hasUnknownAccounting =
    trialsWithoutAccounting > 0 ||
    (report.runMode === InteractiveRunMode.LIVE && trials.length === 0);
  const requests = trials.flatMap((trial) => trial.agent?.modelRequests ?? []);
  const accounting = summarizeEvaluationUsage(
    hasUnknownAccounting && requests.length === 0 ? null : requests,
    report.config.pricing,
  );
  return {
    ...accounting,
    estimatedCostUsd: hasUnknownAccounting ? null : accounting.estimatedCostUsd,
    trialsWithoutAccounting,
  };
}

interface LatencyDistribution {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

function describeLatency(values: (number | null)[]): LatencyDistribution {
  const measured = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  return {
    samples: measured.length,
    p50Ms: measured[Math.max(0, Math.ceil(measured.length * 0.5) - 1)] ?? null,
    p95Ms: measured[Math.max(0, Math.ceil(measured.length * 0.95) - 1)] ?? null,
  };
}

function hasSuccessfulOutcome(trial: InteractiveTrialResult): boolean {
  return trial.status === InteractiveTrialStatus.SETTLED && trial.outcomePassed;
}

/** Only comparable, unique off/on trials count as pairs. Missing or duplicate
 * trials remain unmatched rather than silently improving either variant. */
export function summarizeInteractivePairs(report: InteractiveEvaluationReport) {
  const pairs = new Map<string, InteractiveTrialResult[]>();
  for (const trial of report.trials) {
    const key = `${trial.pairId}:${trial.startingStateId}:${trial.scenarioId}`;
    const pair = pairs.get(key) ?? [];
    pair.push(trial);
    pairs.set(key, pair);
  }
  let contextOnWins = 0;
  let contextOffWins = 0;
  let bothPassed = 0;
  let neitherPassed = 0;
  let unmatchedTrials = 0;
  for (const pair of pairs.values()) {
    const off = pair.find((trial) => trial.variant === InteractiveVariant.OFF);
    const on = pair.find((trial) => trial.variant === InteractiveVariant.ON);
    if (pair.length !== 2 || !off || !on) {
      unmatchedTrials += pair.length;
      continue;
    }
    const offPassed = hasSuccessfulOutcome(off);
    const onPassed = hasSuccessfulOutcome(on);
    if (onPassed && offPassed) {
      bothPassed += 1;
    } else if (onPassed) {
      contextOnWins += 1;
    } else if (offPassed) {
      contextOffWins += 1;
    } else {
      neitherPassed += 1;
    }
  }
  return { contextOnWins, contextOffWins, bothPassed, neitherPassed, unmatchedTrials };
}

/** Native task outcomes, tool/request accounting and latency remain separate. A
 * failed/timed-out agent cannot become a passing full run just because state changed. */
export function summarizeInteractiveResults(report: InteractiveEvaluationReport) {
  return Object.values(InteractiveVariant).map((variant) => {
    const trials = report.trials.filter((trial) => trial.variant === variant);
    const accounting = summarizeInteractiveAccounting(report, trials);
    return {
      variant,
      trials: trials.length,
      successful: trials.filter(hasSuccessfulOutcome).length,
      outcomePassed: trials.filter((trial) => trial.outcomePassed).length,
      timeouts: trials.filter((trial) => trial.status === InteractiveTrialStatus.TIMED_OUT).length,
      failed: trials.filter((trial) => trial.status === InteractiveTrialStatus.FAILED).length,
      cursorMovementObserved: trials.filter((trial) => trial.cursorMoved).length,
      gatewayRequests: accounting.gatewayCalls,
      requestsWithUnknownUsage: accounting.requestsWithUnknownUsage,
      trialsWithoutAccounting: accounting.trialsWithoutAccounting,
      inputTokensObserved: accounting.inputTokensObserved,
      outputTokensObserved: accounting.outputTokensObserved,
      accounting,
      firstObservedInput: describeLatency(trials.map((trial) => trial.firstObservedInputMs)),
      firstVerifiedOutcome: describeLatency(trials.map((trial) => trial.firstVerifiedOutcomeMs)),
      cueAcknowledged: describeLatency(trials.map((trial) => trial.cueAcknowledgedMs)),
    };
  });
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ');
}

function formatLatency(distribution: LatencyDistribution): string {
  return distribution.samples
    ? `${String(distribution.p50Ms)} / ${String(distribution.p95Ms)} (n=${String(distribution.samples)})`
    : 'unmeasured';
}

function formatUsageCount(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function formatUsageCost(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(6)}`;
}

export function formatInteractiveEvaluationReport(report: InteractiveEvaluationReport): string {
  const summaries = summarizeInteractiveResults(report);
  const accounting = summarizeInteractiveAccounting(report);
  const pairs = summarizeInteractivePairs(report);
  const lines = [
    '# Tro interactive evaluation',
    '',
    'Internal development benchmark. Results are local test artifacts, not student assessments.',
    '',
    `Mode: ${report.runMode}. Application: ${report.config.application}. Model: ${report.model}. Generated: ${report.generatedAt}.`,
    '',
    report.config.application === EvaluationApplication.VSCODE
      ? 'Target: the actual installed VS Code in a separate evaluation profile. The selected Python exercise may be a customer reconstruction or a generated variation; its manifest records provenance. Customer reconstructions use an authored paraphrase when the original request is unavailable. Saved source is checked by a bounded independent interpreter; it does not execute Python or establish physical student input, visible cue pixels or learner understanding. Inside VSCode-<trialId>/, Scenario.json describes the input and ProgramOutcome.md lists the program checks.'
      : report.config.application === EvaluationApplication.SCRATCH
        ? 'Target: the actual Scratch web editor in a fresh anonymous evaluation profile. An authored SB3 is imported through the editor and the final project is exported through its UI. Block graph and score observations determine the outcome; no private VM global or model completion claim is used as truth. Unsupported programs remain unassessed.'
        : 'Target: the controlled study workspaces used for harness checks. These are not real Scratch or VS Code.',
    '',
    ...(report.config.evaluationScenario
      ? [
          `Scenario: ${escapeCell(report.config.evaluationScenario.id)} v${String(report.config.evaluationScenario.version)}. Provenance: ${report.config.evaluationScenario.provenance.kind}. Learner mode: ${report.config.taskMode === AgentTaskMode.TEACH ? 'human operator required' : 'agent executes the repair; no learner simulated'}.`,
          '',
        ]
      : []),
    report.config.application === EvaluationApplication.VSCODE &&
    report.runMode === InteractiveRunMode.PREFLIGHT
      ? '**Preflight only. The isolated application was launched and the saved starting program was read and graded. UI rendering and readiness are not independently observed by this adapter. No model request, native input, cursor motion or teaching success was measured.**'
      : report.runMode === InteractiveRunMode.PREFLIGHT
        ? '**Preflight only. Fixture rendering/readback was exercised. No model request, native input, cursor motion or teaching success was measured.**'
        : 'Live runs invoke the production ComputerUseTaskRunner and native driver from a utility worker through the authenticated Tro model gateway. Outcomes come from independent application-state readback, not agent completion claims.',
    '',
    `Planned trials: ${String(report.expectedTrials)}. Attempted: ${String(report.trials.length)}. Outcome: ${report.outcome}.`,
    ...(report.stopReason ? [`Stop reason: ${escapeCell(report.stopReason)}.`] : []),
    '',
    'The native driver has desktop-wide capabilities. A fullscreen fixture is not containment; a dedicated test desktop is an operator prerequisite, not a guarantee verified by a flag. Authored history is injected through the context port; native history collection, HTTP/Prisma context persistence and embedding retrieval are outside this comparison.',
    '',
    '## Preflight',
    '',
    '| Case | Rendering observed | Browser targets | Initial state already passed |',
    '| --- | --- | ---: | --- |',
    ...report.preflight.map(
      (item) =>
        `| ${item.scenarioId} | ${String(item.rendered)} | ${String(item.targets)} | ${String(item.initialOutcomePassed)} |`,
    ),
    '',
    '## Native run summary',
    '',
    '| Variant | Attempts | Agent settled + outcome passed | State passed | Timeouts | Cursor movement observed | Gateway requests |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summaries.map(
      (item) =>
        `| ${item.variant} | ${String(item.trials)} | ${String(item.successful)} | ${String(item.outcomePassed)} | ${String(item.timeouts)} | ${String(item.cursorMovementObserved)} | ${String(item.gatewayRequests)} |`,
    ),
    '',
    `Matched pairs: context-on wins ${String(pairs.contextOnWins)}, context-off wins ${String(pairs.contextOffWins)}, both passed ${String(pairs.bothPassed)}, neither passed ${String(pairs.neitherPassed)}. Unmatched trials: ${String(pairs.unmatchedTrials)}.`,
    '',
    '## Timing and usage',
    '',
    'Times are main-process monotonic spans from dispatch, observed by bounded polling. First input may be incorrect; first verified outcome means the fixture predicate passed. Cue acknowledgment is host installation evidence, not independent visible pixels. Audio and physical display scan-out are unmeasured. A timeout remains a timeout even if a partial app effect occurred.',
    '',
    '| Variant | Input P50/P95 ms | Verified outcome P50/P95 ms | Cue acknowledgment P50/P95 ms | Observed input/output tokens | Requests with unknown usage | Trials without accounting |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
    ...summaries.map(
      (item) =>
        `| ${item.variant} | ${formatLatency(item.firstObservedInput)} | ${formatLatency(item.firstVerifiedOutcome)} | ${formatLatency(item.cueAcknowledged)} | ${String(item.inputTokensObserved)} / ${String(item.outputTokensObserved)} | ${String(item.requestsWithUnknownUsage)} | ${String(item.trialsWithoutAccounting)} |`,
    ),
    '',
    'Gateway HTTP requests can include backend transport retries that are invisible to this observer. Observed token subtotals are not complete provider-attempt accounting or a class-cost estimate; prices remain unknown for calls without a matching rate card. Logged native CUA tool counts, per-request model timings and usage details are retained in JSON without screenshot pixels, typed key contents, credentials or raw model replies.',
    '',
    '## Observed model calls and estimated cost',
    '',
    `Trials without accounting: ${String(accounting.trialsWithoutAccounting)}. Missing trial accounting keeps the run estimate unknown; priced calls still contribute to the known subtotal.`,
    '',
    formatEvaluationUsage(accounting),
    '',
    '| Variant | Observed gateway calls | Input / output token subtotals | Estimated observed-call USD | Known priced USD subtotal | Unpriced observed calls | Trials without accounting |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summaries.map(
      ({ variant, accounting: usage }) =>
        `| ${variant} | ${formatUsageCount(usage.gatewayCalls)} | ${formatUsageCount(usage.inputTokensObserved)} / ${formatUsageCount(usage.outputTokensObserved)} | ${formatUsageCost(usage.estimatedCostUsd)} | ${formatUsageCost(usage.knownEstimatedCostUsd)} | ${formatUsageCount(usage.unpricedCalls)} | ${String(usage.trialsWithoutAccounting)} |`,
    ),
    '',
    '| Scenario / trial | Observed calls | Input | Cached input | Output | Estimated USD | Unpriced calls |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.trials.map((trial) => {
      const usage = summarizeInteractiveAccounting(report, [trial]);
      return `| ${escapeCell(trial.scenarioId)} / ${trial.trialId} | ${formatUsageCount(usage.gatewayCalls)} | ${formatUsageCount(usage.inputTokensObserved)} | ${formatUsageCount(usage.cachedInputTokensObserved)} | ${formatUsageCount(usage.outputTokensObserved)} | ${formatUsageCost(usage.estimatedCostUsd)} | ${formatUsageCount(usage.unpricedCalls)} |`;
    }),
    '',
    '## Trial results',
    '',
    '| Case | Variant | Repetition | Agent status | Completion mode/status | Independent outcome | Reasons |',
    '| --- | --- | ---: | --- | --- | --- | --- |',
    ...report.trials.map(
      (trial) =>
        `| ${trial.scenarioId} | ${trial.variant} | ${String(trial.repetition)} | ${trial.status} | ${trial.agent?.completionMode ?? 'unmeasured'} / ${trial.agent?.taskOutcomeStatus ?? 'unmeasured'} | ${String(trial.outcomePassed)} | ${escapeCell(trial.reasons.join(', '))} |`,
    ),
    '',
    'The history task deliberately withholds the assignment in context-off. Asking for clarification is appropriate when the assignment is unknown; it leaves the app task incomplete and must not be interpreted as an unsafe or incorrect action. Completion metadata is retained without model answer text. Cursor positions use desktop DIPs; target rectangles use viewport CSS pixels, with scale and window bounds retained for diagnosis. Movement alone is not target accuracy.',
    '',
    'No student learning was assessed. Execute mode measures agent task completion. Teach mode requires a real operator to perform the steps; scripted or operator actions do not establish student understanding. Independent prediction/transfer probes remain a separate evaluation.',
    '',
  ];
  return lines.join('\n');
}
