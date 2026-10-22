import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ModelGatewayDiagnostics } from '../../../src/contracts/ModelGatewayError.js';
import { ModelObservationProjection } from '../../../src/desktop/worker/agent/ModelObservationProjection.js';
import {
  summarizeEvaluationUsage,
  formatEvaluationUsage,
  type EvaluationUsageSummary,
  type EvaluationPriceCard,
} from '../accounting/EvaluationUsage.js';
import {
  InteractiveAgentSettledSchema,
  InteractiveModelRequestSchema,
  type InteractiveModelRequest,
} from './InteractiveAgentProtocol.js';
import { InteractiveEvaluationConfigSchema } from './InteractiveEvaluationConfig.js';
import { InteractiveReportOutcome, InteractiveTrialStatus } from './InteractiveEvaluationReport.js';

const TrialSchema = z.object({
  trialId: z.uuid(),
  scenarioId: z.string().min(1).max(160),
  startingStateId: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(InteractiveTrialStatus),
  outcomePassed: z.boolean(),
  reasons: z.array(z.string().max(256)).max(100),
  taskDurationMs: z.number().nonnegative(),
  firstObservedInputMs: z.number().nonnegative().nullable(),
  firstVerifiedOutcomeMs: z.number().nonnegative().nullable(),
  cursorMoved: z.boolean(),
  recording: z.object({ traceComplete: z.boolean() }).optional(),
  agent: z
    .object({
      ...InteractiveAgentSettledSchema.pick({
        failed: true,
        durationMs: true,
        modelRequests: true,
        toolCalls: true,
        mutationCalls: true,
        observationProjections: true,
        observationProjectionOverflow: true,
        gatewayFailure: true,
      }).shape,
      resultKind: z.string().max(64).nullable(),
      taskOutcomeStatus: z.string().max(64).nullable(),
    })
    .nullable(),
});

/** Only the accounting, identity and independent-outcome projection is read.
 * Full reports can contain other bounded public artifacts; none is trusted as code. */
export const ObservationComparisonInputSchema = z.object({
  schemaVersion: z.literal(1),
  config: InteractiveEvaluationConfigSchema,
  model: z.string().min(1).max(160),
  applicationRevision: z.string().max(128).nullable(),
  outcome: z.enum(InteractiveReportOutcome),
  trials: z.array(TrialSchema).length(1),
});

export type ObservationComparisonInput = z.infer<typeof ObservationComparisonInputSchema>;

export interface ObservationCostBounds {
  minimumUsd: number | null;
  maximumUsd: number | null;
  basis: string;
}

/** A missing write count can be any part of input minus cache reads. Bounds
 * cover those two standard-rate allocations only, never hidden provider retries. */
export function estimateObservationCostBounds(
  requests: readonly InteractiveModelRequest[],
  pricing: EvaluationPriceCard | undefined,
): ObservationCostBounds {
  const unavailable: ObservationCostBounds = {
    minimumUsd: null,
    maximumUsd: null,
    basis:
      'Unavailable: exact model, complete core usage and applicable input/write rates are required.',
  };
  if (!pricing || requests.length === 0) {
    return unavailable;
  }
  const lower: InteractiveModelRequest[] = [];
  const upper: InteractiveModelRequest[] = [];
  for (const request of requests) {
    const parsed = InteractiveModelRequestSchema.safeParse(request);
    if (
      !parsed.success ||
      request.inputTokens === null ||
      request.cachedInputTokens === null ||
      request.outputTokens === null
    ) {
      return unavailable;
    }
    const model = pricing.models.find((item) => item.model === request.model);
    const tier = model?.tiers.find(
      (item) =>
        item.maximumInputTokens === null ||
        (request.inputTokens !== null && request.inputTokens <= item.maximumInputTokens),
    );
    if (!model || !tier) {
      return unavailable;
    }
    if (request.cacheWriteInputTokens === null || request.cacheWriteInputTokens === undefined) {
      if (model.missingCacheWriteTokens === 'zero') {
        lower.push({ ...request, cacheWriteInputTokens: 0 });
        upper.push({ ...request, cacheWriteInputTokens: 0 });
      } else {
        if (tier.cacheWriteInputUsdPerMillion === null) {
          return unavailable;
        }
        const remaining = request.inputTokens - request.cachedInputTokens;
        const writeIsMoreExpensive = tier.cacheWriteInputUsdPerMillion >= tier.inputUsdPerMillion;
        lower.push({ ...request, cacheWriteInputTokens: writeIsMoreExpensive ? 0 : remaining });
        upper.push({ ...request, cacheWriteInputTokens: writeIsMoreExpensive ? remaining : 0 });
      }
    } else {
      lower.push(request);
      upper.push(request);
    }
  }
  return {
    minimumUsd: summarizeEvaluationUsage(lower, pricing).estimatedCostUsd,
    maximumUsd: summarizeEvaluationUsage(upper, pricing).estimatedCostUsd,
    basis:
      'Observed calls at snapshot standard rates; omitted cache writes range from zero to all input minus cache reads. Excludes hidden provider attempts, invoice adjustments and discounts.',
  };
}

export interface ObservationComparisonRow {
  projection: ModelObservationProjection;
  outputDirectory: string;
  launchCompleted: boolean;
  applicationRevision: string | null;
  sourceSha256: Readonly<Record<string, string>>;
  scenarioId: string;
  startingStateId: string;
  configuredModel: string;
  comparisonConfigSha256: string;
  pricingSnapshotSha256: string | null;
  reportedModels: string[];
  agentStatus: string;
  taskSolved: boolean;
  independentlyPassed: boolean;
  agentResultKind: string | null;
  agentOutcomeStatus: string | null;
  gatewayFailure: ModelGatewayDiagnostics | null;
  traceComplete: boolean;
  cursorMoved: boolean;
  taskDurationMs: number;
  firstObservedInputMs: number | null;
  firstVerifiedOutcomeMs: number | null;
  modelDurationMs: number | null;
  toolCalls: number | null;
  usage: EvaluationUsageSummary;
  inputMinusCacheReadTokens: number | null;
  standardRateCostBounds: ObservationCostBounds;
  projectionMeasurements: {
    recorded: number | null;
    toon: number | null;
    json: number | null;
    duplicateCopiesAvoided: number | null;
    elapsedMs: number | null;
    measuredTokenSaving: number | null;
    overflow: boolean;
  };
}

export function summarizeObservationComparisonRun(
  input: ObservationComparisonInput,
  outputDirectory: string,
  launchCompleted: boolean,
  sourceSha256: Readonly<Record<string, string>> = {},
): ObservationComparisonRow {
  const trial = input.trials[0];
  if (!trial) {
    throw new Error('observation_comparison_trial_required');
  }
  const agent = trial.agent;
  const usage = summarizeEvaluationUsage(agent?.modelRequests ?? null, input.config.pricing);
  const projections = agent?.observationProjections;
  return {
    projection: input.config.observationProjection,
    outputDirectory,
    launchCompleted,
    applicationRevision: input.applicationRevision,
    sourceSha256,
    scenarioId: trial.scenarioId,
    startingStateId: trial.startingStateId,
    configuredModel: input.model,
    comparisonConfigSha256: createHash('sha256')
      .update(
        JSON.stringify({
          ...input.config,
          observationProjection: ModelObservationProjection.ADAPTIVE_TOON,
        }),
      )
      .digest('hex'),
    pricingSnapshotSha256: input.config.pricing
      ? createHash('sha256').update(JSON.stringify(input.config.pricing)).digest('hex')
      : null,
    reportedModels: [...new Set(usage.calls.flatMap((call) => (call.model ? [call.model] : [])))],
    agentStatus: trial.status,
    taskSolved:
      launchCompleted &&
      trial.status === InteractiveTrialStatus.SETTLED &&
      trial.outcomePassed &&
      agent?.failed === false,
    independentlyPassed: trial.outcomePassed,
    agentResultKind: agent?.resultKind ?? null,
    agentOutcomeStatus: agent?.taskOutcomeStatus ?? null,
    gatewayFailure: agent?.gatewayFailure ?? null,
    traceComplete: trial.recording?.traceComplete ?? false,
    cursorMoved: trial.cursorMoved,
    taskDurationMs: trial.taskDurationMs,
    firstObservedInputMs: trial.firstObservedInputMs,
    firstVerifiedOutcomeMs: trial.firstVerifiedOutcomeMs,
    modelDurationMs: agent
      ? agent.modelRequests.reduce((sum, call) => sum + call.durationMs, 0)
      : null,
    toolCalls: agent?.toolCalls ?? null,
    usage,
    inputMinusCacheReadTokens:
      usage.requestsWithUnknownUsage === 0 &&
      usage.inputTokensObserved !== null &&
      usage.cachedInputTokensObserved !== null
        ? usage.inputTokensObserved - usage.cachedInputTokensObserved
        : null,
    standardRateCostBounds: estimateObservationCostBounds(
      agent?.modelRequests ?? [],
      input.config.pricing,
    ),
    projectionMeasurements: {
      recorded: projections?.length ?? null,
      toon: projections?.filter((item) => item.format === 'toon').length ?? null,
      json: projections?.filter((item) => item.format === 'json').length ?? null,
      duplicateCopiesAvoided:
        projections?.filter((item) => item.duplicateCopyAvoided).length ?? null,
      elapsedMs: projections?.reduce((sum, item) => sum + item.elapsedMs, 0) ?? null,
      measuredTokenSaving:
        projections?.reduce(
          (sum, item) =>
            sum +
            (item.jsonTokens === null || item.outputTokens === null
              ? 0
              : item.jsonTokens - item.outputTokens),
          0,
        ) ?? null,
      overflow: agent?.observationProjectionOverflow ?? false,
    },
  };
}

export const ToonCoverage = {
  EXERCISED: 'exercised',
  NOT_EXERCISED: 'not_exercised',
  UNKNOWN: 'unknown',
} as const;

export type ToonCoverage = (typeof ToonCoverage)[keyof typeof ToonCoverage];

function readToonCoverage(runs: readonly ObservationComparisonRow[]): ToonCoverage {
  const adaptive = runs.filter(
    (run) => run.projection === ModelObservationProjection.ADAPTIVE_TOON,
  );
  const measurements = adaptive[0]?.projectionMeasurements;
  if (
    adaptive.length !== 1 ||
    !measurements ||
    measurements.overflow ||
    measurements.recorded === null ||
    measurements.toon === null ||
    measurements.json === null ||
    measurements.toon + measurements.json !== measurements.recorded
  ) {
    return ToonCoverage.UNKNOWN;
  }
  return measurements.toon > 0 ? ToonCoverage.EXERCISED : ToonCoverage.NOT_EXERCISED;
}

export interface ObservationEncodingComparisonReport {
  schemaVersion: 1;
  generatedAt: string;
  comparison: 'legacy-json-before-toon-vs-adaptive-toon';
  matchingStartingState: boolean;
  hasPairedProjections: boolean;
  matchingConfiguration: boolean;
  matchingPricingSnapshot: boolean;
  matchingConfiguredModel: boolean;
  matchingSourceHashes: boolean;
  matchingReportedModels: boolean | null;
  bothSolved: boolean;
  toonCoverage: ToonCoverage;
  runs: ObservationComparisonRow[];
  limitations: string[];
}

export function createObservationEncodingComparisonReport(
  runs: ObservationComparisonRow[],
): ObservationEncodingComparisonReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    comparison: 'legacy-json-before-toon-vs-adaptive-toon',
    hasPairedProjections:
      runs.length === 2 &&
      new Set(runs.map((run) => run.projection)).size === 2 &&
      runs.some((run) => run.projection === ModelObservationProjection.LEGACY_JSON) &&
      runs.some((run) => run.projection === ModelObservationProjection.ADAPTIVE_TOON),
    matchingConfiguration:
      runs.length === 2 && new Set(runs.map((run) => run.comparisonConfigSha256)).size === 1,
    matchingPricingSnapshot:
      runs.length === 2 && new Set(runs.map((run) => run.pricingSnapshotSha256)).size === 1,
    matchingStartingState:
      runs.length === 2 &&
      new Set(runs.map((run) => run.startingStateId)).size === 1 &&
      new Set(runs.map((run) => run.scenarioId)).size === 1,
    matchingConfiguredModel:
      runs.length === 2 && new Set(runs.map((run) => run.configuredModel)).size === 1,
    matchingSourceHashes:
      runs.length === 2 &&
      runs.every((run) => Object.keys(run.sourceSha256).length > 0) &&
      new Set(runs.map((run) => JSON.stringify(run.sourceSha256))).size === 1,
    matchingReportedModels:
      runs.length !== 2 ||
      runs.some(
        (run) =>
          run.reportedModels.length === 0 || run.usage.calls.some((call) => call.model === null),
      )
        ? null
        : new Set(runs.map((run) => [...run.reportedModels].sort().join(','))).size === 1,
    bothSolved: runs.length === 2 && runs.every((run) => run.taskSolved),
    toonCoverage: readToonCoverage(runs),
    runs,
    limitations: [
      'One fresh trial per projection is a smoke comparison, not a statistical performance claim; model decisions and desktop observations can differ.',
      'Legacy JSON runs first and includes the old unconditional metadata append. Adaptive TOON includes exact-duplicate avoidance. This compares the whole observation-projection change, not isolated serialization alone.',
      'Workspaces, workers and agent histories are fresh per run. Provider caches are not flushed; order and cache reuse can change timing and estimated cost.',
      'Input minus cache reads includes any cache writes; it is not necessarily standard-rate fresh input. Token subtotals can omit terminal usage and hidden backend attempts.',
      'Canonical cost stays unknown when cache-write counts or other required metadata are missing. Standard-rate bounds concern only observed calls at the saved snapshot rates, not an invoice.',
      'The independent saved-program interpreter establishes task behavior. Student understanding, audio latency and independently visible cue pixels are not evaluated.',
      'Projection token savings are local text proxies for measured projections and exclude screenshots, transport envelopes, tool schemas and uncounted fast paths.',
    ],
  };
}

function count(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function seconds(value: number | null): string {
  return value === null ? 'unmeasured' : (value / 1000).toFixed(3);
}

function money(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(6)}`;
}

function describeToonCoverage(coverage: ToonCoverage): string {
  switch (coverage) {
    case ToonCoverage.NOT_EXERCISED:
      return '**TOON not exercised; any usage/timing difference is descriptive and cannot be attributed to encoding.**';
    case ToonCoverage.EXERCISED:
      return 'TOON was used in observed projections. One paired run does not establish that encoding caused usage or timing differences.';
    case ToonCoverage.UNKNOWN:
      return 'Projection metrics are missing, ambiguous or incomplete; encoding effects cannot be established.';
  }
}

/** Readable row metrics keep independent outcome, metadata and coverage separate. */
export function formatObservationEncodingComparisonReport(
  report: ObservationEncodingComparisonReport,
): string {
  return [
    '# Live Python observation encoding comparison',
    '',
    `One legacy/adaptive pair: ${report.hasPairedProjections ? 'PASS' : 'FAIL'}. Matching configuration: ${report.matchingConfiguration ? 'PASS' : 'FAIL'}. Matching rate snapshot: ${report.matchingPricingSnapshot ? 'PASS' : 'FAIL'}. Matching starting state: ${report.matchingStartingState ? 'PASS' : 'FAIL'}. Matching configured model: ${report.matchingConfiguredModel ? 'PASS' : 'FAIL'}. Matching reported models: ${report.matchingReportedModels === null ? 'UNASSESSED' : report.matchingReportedModels ? 'PASS' : 'FAIL'}. Matching source hashes: ${report.matchingSourceHashes ? 'PASS' : 'FAIL/UNKNOWN'}. Both tasks solved: ${report.bothSolved ? 'PASS' : 'FAIL'}.`,
    '',
    `TOON coverage: ${report.toonCoverage}. ${describeToonCoverage(report.toonCoverage)}`,
    '',
    '| Projection | Solved | Independent outcome | Calls | Input | Cached | Input minus cache reads | Output | Estimated USD | Standard-rate bounds USD | Task seconds | First input seconds | First verified repair seconds |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
    ...report.runs.map(
      (run) =>
        `| ${run.projection} | ${String(run.taskSolved)} | ${String(run.independentlyPassed)} | ${count(run.usage.gatewayCalls)} | ${count(run.usage.inputTokensObserved)} | ${count(run.usage.cachedInputTokensObserved)} | ${count(run.inputMinusCacheReadTokens)} | ${count(run.usage.outputTokensObserved)} | ${money(run.usage.estimatedCostUsd)} | ${money(run.standardRateCostBounds.minimumUsd)}–${money(run.standardRateCostBounds.maximumUsd)} | ${seconds(run.taskDurationMs)} | ${seconds(run.firstObservedInputMs)} | ${seconds(run.firstVerifiedOutcomeMs)} |`,
    ),
    '',
    '| Projection | Reported models | Agent status / result / outcome | Trace complete | Cursor moved | Native tool calls | Summed gateway seconds | TOON / JSON projections | Duplicate copies avoided | Local projection ms |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.runs.map(
      (run) =>
        `| ${run.projection} | ${run.reportedModels.join(', ') || 'unknown'} | ${run.agentStatus} / ${run.agentResultKind ?? 'unknown'} / ${run.agentOutcomeStatus ?? 'unknown'} | ${String(run.traceComplete)} | ${String(run.cursorMoved)} | ${count(run.toolCalls)} | ${seconds(run.modelDurationMs)} | ${count(run.projectionMeasurements.toon)} / ${count(run.projectionMeasurements.json)}${run.projectionMeasurements.overflow ? ' (overflow)' : ''} | ${count(run.projectionMeasurements.duplicateCopiesAvoided)} | ${count(run.projectionMeasurements.elapsedMs)} |`,
    ),
    '',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
    ...report.runs.flatMap((run) => [
      `## ${run.projection}`,
      '',
      `Scenario: ${run.scenarioId}. Revision: ${run.applicationRevision ?? 'unknown'}. Starting state: ${run.startingStateId}.`,
      `Artifacts: ${run.outputDirectory}`,
      `Projection source SHA256: ${JSON.stringify(run.sourceSha256)}`,
      `Configuration SHA256 excluding projection: ${run.comparisonConfigSha256}. Rate snapshot SHA256: ${run.pricingSnapshotSha256 ?? 'unavailable'}.`,
      `Cost bounds: ${run.standardRateCostBounds.basis}`,
      `Gateway failure diagnostics: ${run.gatewayFailure ? JSON.stringify(run.gatewayFailure) : 'unavailable'}.`,
      '',
      formatEvaluationUsage(run.usage),
      '',
    ]),
  ].join('\n');
}
