import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ModelObservationProjection } from '../../../src/desktop/worker/agent/ModelObservationProjection.js';
import { EvaluationPriceCardSchema } from '../accounting/EvaluationUsage.js';
import { parseInteractiveEvaluationOptions } from './InteractiveEvaluationConfig.js';
import {
  ObservationComparisonInputSchema,
  createObservationEncodingComparisonReport,
  estimateObservationCostBounds,
  formatObservationEncodingComparisonReport,
  summarizeObservationComparisonRun,
  ToonCoverage,
} from './ObservationEncodingComparison.js';

const pricing = EvaluationPriceCardSchema.parse({
  schemaVersion: 1,
  id: 'AuthoredPricesNotProviderRates',
  currency: 'USD',
  source: 'Synthetic unit-test fixture',
  effectiveAt: '2026-10-21T00:00:00.000Z',
  models: [
    {
      model: 'authored-test-model',
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

function createRequest() {
  return {
    id: randomUUID(),
    status: 200,
    durationMs: 500,
    model: 'authored-test-model',
    inputTokens: 1000,
    cachedInputTokens: 200,
    cacheWriteInputTokens: null,
    outputTokens: 100,
    reasoningTokens: 50,
  };
}

function createInput(
  projection: ModelObservationProjection = ModelObservationProjection.ADAPTIVE_TOON,
) {
  const config = parseInteractiveEvaluationOptions([
    '--application',
    'vscode',
    '--execute',
    '--live',
    '--dedicated-desktop',
    '--credential-stdin',
  ]).config;
  return ObservationComparisonInputSchema.parse({
    schemaVersion: 1,
    config: { ...config, observationProjection: projection, pricing },
    model: 'gpt-6.1-sol',
    applicationRevision: 'a'.repeat(40),
    outcome: 'finished',
    trials: [
      {
        trialId: randomUUID(),
        scenarioId: 'PythonMissingBreakSeed1',
        startingStateId: 'b'.repeat(64),
        status: 'settled',
        outcomePassed: true,
        reasons: [],
        taskDurationMs: 700,
        firstObservedInputMs: 100,
        firstVerifiedOutcomeMs: 600,
        cursorMoved: true,
        recording: { traceComplete: true },
        agent: {
          failed: false,
          durationMs: 650,
          modelRequests: [createRequest()],
          toolCalls: 3,
          mutationCalls: 1,
          resultKind: 'completed',
          taskOutcomeStatus: 'unverified',
          observationProjections: [
            {
              toolName: 'get_window_state',
              callId: 'call-1',
              format: projection === ModelObservationProjection.LEGACY_JSON ? 'json' : 'toon',
              jsonCharacters: 5000,
              outputCharacters: 3000,
              jsonTokens: 2000,
              outputTokens: 1200,
              elapsedMs: 4,
              duplicateCopyAvoided: projection !== ModelObservationProjection.LEGACY_JSON,
            },
          ],
          observationProjectionOverflow: false,
        },
      },
    ],
  });
}

it('keeps canonical cost unknown while bounding the omitted write allocation without double-charging reasoning', () => {
  const input = createInput();
  const row = summarizeObservationComparisonRun(input, '/authored/report', true, {
    formatter: 'c'.repeat(64),
  });
  expect(row.usage.estimatedCostUsd).toBeNull();
  expect(row.usage.calls[0]?.costReason).toBe('cache_write_unknown');
  expect(row.standardRateCostBounds.minimumUsd).toBeCloseTo(0.00262, 6);
  expect(row.standardRateCostBounds.maximumUsd).toBeCloseTo(0.00302, 6);
  expect(row.inputMinusCacheReadTokens).toBe(800);
  expect(row.projectionMeasurements).toMatchObject({
    toon: 1,
    json: 0,
    duplicateCopiesAvoided: 1,
    measuredTokenSaving: 800,
  });
  expect(row.taskSolved).toBe(true);
  expect(row.agentOutcomeStatus).toBe('unverified');
});

it('preserves allowlisted gateway failure diagnostics in the readable comparison', () => {
  const input = createInput();
  const trial = input.trials[0];
  if (!trial?.agent) {
    throw new Error('Expected authored agent evidence.');
  }
  const failed = ObservationComparisonInputSchema.parse({
    ...input,
    trials: [
      {
        ...trial,
        status: 'failed',
        outcomePassed: false,
        agent: {
          ...trial.agent,
          failed: true,
          gatewayFailure: {
            gatewayRequestId: 'req-synthetic-gateway',
            reason: 'provider_rejected',
            attemptNumber: 1,
            durationMs: 470,
            providerStatus: 400,
            providerParameter: 'tools[0].parameters',
            rawResponse: 'PRIVATE_PROVIDER_BODY',
          },
        },
      },
    ],
  });
  const row = summarizeObservationComparisonRun(failed, '/authored/report', true);
  expect(row.gatewayFailure).toMatchObject({ providerStatus: 400 });
  const report = createObservationEncodingComparisonReport([row]);
  const markdown = formatObservationEncodingComparisonReport(report);
  expect(markdown).toContain('Gateway failure diagnostics:');
  expect(markdown).toContain('"providerStatus":400');
  expect(markdown).not.toContain('PRIVATE_PROVIDER_BODY');
  expect(row.taskSolved).toBe(false);
});

it('prices known writes exactly and leaves missing metadata or missing rates unbounded', () => {
  const request = createRequest();
  const exact = estimateObservationCostBounds(
    [{ ...request, cacheWriteInputTokens: 100 }],
    pricing,
  );
  expect(exact.minimumUsd).toBe(exact.maximumUsd);
  for (const requests of [
    [],
    [{ ...request, model: null }],
    [{ ...request, cachedInputTokens: null }],
  ]) {
    expect(estimateObservationCostBounds(requests, pricing).minimumUsd).toBeNull();
  }
  expect(estimateObservationCostBounds([request], undefined).maximumUsd).toBeNull();
  const noWriteRate = structuredClone(pricing);
  const tier = noWriteRate.models[0]?.tiers[0];
  if (!tier) {
    throw new Error('Expected authored rate tier.');
  }
  tier.cacheWriteInputUsdPerMillion = null;
  expect(estimateObservationCostBounds([request], noWriteRate).maximumUsd).toBeNull();
});

it('preserves failed launches and partial outcomes instead of marking a passing state as solved', () => {
  const input = createInput();
  expect(summarizeObservationComparisonRun(input, '/authored/report', false).taskSolved).toBe(
    false,
  );
  const trial = input.trials[0];
  if (!trial) {
    throw new Error('Expected trial.');
  }
  trial.status = 'timed_out';
  trial.agent = null;
  const row = summarizeObservationComparisonRun(input, '/authored/report', true);
  expect(row.taskSolved).toBe(false);
  expect(row.independentlyPassed).toBe(true);
  expect(row.usage.gatewayCalls).toBeNull();
  expect(row.projectionMeasurements.recorded).toBeNull();
});

it('requires the same scenario, model, source and initial state and describes cache/order limitations', () => {
  const hashes = { formatter: 'c'.repeat(64) };
  const legacy = summarizeObservationComparisonRun(
    createInput(ModelObservationProjection.LEGACY_JSON),
    '/authored/before',
    true,
    hashes,
  );
  const adaptive = summarizeObservationComparisonRun(
    createInput(),
    '/authored/after',
    true,
    hashes,
  );
  const report = createObservationEncodingComparisonReport([legacy, adaptive]);
  expect(report).toMatchObject({
    hasPairedProjections: true,
    matchingConfiguration: true,
    matchingPricingSnapshot: true,
    matchingStartingState: true,
    matchingConfiguredModel: true,
    matchingSourceHashes: true,
    matchingReportedModels: true,
    bothSolved: true,
  });
  const text = formatObservationEncodingComparisonReport(report);
  expect(text).toContain('Input minus cache reads');
  expect(text).toContain('Legacy JSON runs first');
  expect(text).toContain('not a statistical performance claim');
  expect(text).toContain('cache_write_unknown');
  expect(text).toContain('Projection source SHA256');
  expect(
    createObservationEncodingComparisonReport([
      legacy,
      { ...adaptive, startingStateId: 'd'.repeat(64) },
    ]).matchingStartingState,
  ).toBe(false);
  expect(
    createObservationEncodingComparisonReport([
      legacy,
      { ...adaptive, configuredModel: 'different' },
    ]).matchingConfiguredModel,
  ).toBe(false);
  expect(createObservationEncodingComparisonReport([adaptive, adaptive]).hasPairedProjections).toBe(
    false,
  );
  expect(
    createObservationEncodingComparisonReport([
      legacy,
      { ...adaptive, pricingSnapshotSha256: 'different' },
    ]).matchingPricingSnapshot,
  ).toBe(false);
  expect(
    createObservationEncodingComparisonReport([legacy, { ...adaptive, reportedModels: [] }])
      .matchingReportedModels,
  ).toBeNull();
});

it('rejects native contents in projection metrics and malformed report usage', () => {
  const input = createInput();
  const trial = input.trials[0];
  expect(() => ObservationComparisonInputSchema.parse({ ...input, trials: [] })).toThrow();
  expect(() =>
    ObservationComparisonInputSchema.parse({
      ...input,
      trials: [
        {
          ...trial,
          agent: {
            ...trial?.agent,
            observationProjections: [
              { toolName: 'get_window_state', sourceText: 'private screen' },
            ],
          },
        },
      ],
    }),
  ).toThrow();
});

it('distinguishes exercised TOON, a valid zero-TOON pair and incomplete projection coverage', () => {
  const legacy = summarizeObservationComparisonRun(
    createInput(ModelObservationProjection.LEGACY_JSON),
    '/authored/before',
    true,
  );
  const adaptive = summarizeObservationComparisonRun(createInput(), '/authored/after', true);
  expect(createObservationEncodingComparisonReport([legacy, adaptive]).toonCoverage).toBe(
    ToonCoverage.EXERCISED,
  );
  const zero = {
    ...adaptive,
    projectionMeasurements: { ...adaptive.projectionMeasurements, toon: 0, json: 1, recorded: 1 },
  };
  const zeroReport = createObservationEncodingComparisonReport([legacy, zero]);
  expect(zeroReport.toonCoverage).toBe(ToonCoverage.NOT_EXERCISED);
  expect(zeroReport.bothSolved).toBe(true);
  expect(formatObservationEncodingComparisonReport(zeroReport)).toContain(
    'TOON not exercised; any usage/timing difference is descriptive and cannot be attributed to encoding.',
  );
  for (const measurements of [
    { ...adaptive.projectionMeasurements, recorded: null },
    { ...adaptive.projectionMeasurements, overflow: true },
    { ...adaptive.projectionMeasurements, recorded: 2 },
  ]) {
    expect(
      createObservationEncodingComparisonReport([
        legacy,
        { ...adaptive, projectionMeasurements: measurements },
      ]).toonCoverage,
    ).toBe(ToonCoverage.UNKNOWN);
  }
  expect(createObservationEncodingComparisonReport([legacy]).toonCoverage).toBe(
    ToonCoverage.UNKNOWN,
  );
});
