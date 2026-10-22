import { afterEach, expect, it, vi } from 'vitest';
import { ContextLimits } from '../../../src/contracts/StudyContext.js';
import { createQuestionContextCases } from './QuestionContextCases.js';
import {
  formatQuestionContextEvaluation,
  QuestionContextVariant,
  runQuestionContextEvaluation,
} from './QuestionContextEvaluation.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('keeps diagnostic marker identities out of natural questions and pairs authored evidence', () => {
  const cases = createQuestionContextCases(Date.now());
  const full = cases.find((scenario) => scenario.id === 'ThreeHourSession');
  expect(full?.batches).toHaveLength(1080);
  expect(full?.batches.flat()).toHaveLength(20520);
  for (const scenario of cases) {
    const text = scenario.batches
      .flat()
      .map((event) => event.text)
      .join('\n');
    for (const ask of scenario.asks) {
      for (const fact of ask.facts) {
        expect(ask.question).not.toContain(fact.marker);
        expect(text).toContain(fact.marker);
      }
    }
  }
});

it('compares real local components, preserves old facts after receipts/restart and bounds model input', async () => {
  const providerFetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('This local benchmark must not make provider requests.'));
  const report = await runQuestionContextEvaluation({ includeThreeHour: false });
  expect(report.pairedCorpusDigestsMatch).toBe(true);
  expect(report.modelCalls).toBe(0);
  expect(report.embeddingCalls).toBe(0);
  expect(providerFetch).not.toHaveBeenCalled();
  expect(report.actualUsage).toEqual({
    basis: 'no_provider_invocations',
    providerCalls: 0,
    modelCalls: 0,
    embeddingCalls: 0,
    gatewayRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    inferenceCostUsd: 0,
  });
  for (const variant of report.variants) {
    const asks = report.results
      .filter((result) => result.variant === variant.variant)
      .flatMap((result) => result.asks);
    const estimatedTokens = asks.reduce((sum, ask) => sum + ask.estimatedInputTokens, 0);
    expect(variant.asks).toBe(asks.length);
    expect(variant.initialContextTokenEstimates).toEqual({
      total: estimatedTokens,
      averagePerAsk: estimatedTokens / asks.length,
      billed: false,
    });
    expect(estimatedTokens).toBeGreaterThan(0);
    expect(variant.actualUsage).toEqual(report.actualUsage);
    for (const ask of asks) {
      expect(ask.actualUsage).toEqual(report.actualUsage);
      expect(ask.estimatedInputTokens).toBeGreaterThan(0);
    }
  }
  const candidate = report.results.filter(
    (result) => result.variant === QuestionContextVariant.QUESTION,
  );
  for (const result of candidate) {
    expect(result.scopeControls, result.id).toEqual({
      ownerIsolated: true,
      generationIsolated: true,
    });
    for (const ask of result.asks) {
      expect(ask.modelFacts, `${result.id}/${ask.id}`).toEqual(ask.requiredFacts);
      expect(ask.modelInputCharacters).toBeLessThan(ContextLimits.PACKET_CHARACTERS + 500);
      expect(ask.evidenceDelivery.projectedSources.length).toBeGreaterThan(0);
      const ranges = ask.evidenceDelivery.projectedSources.map(
        (source) => `${source.id}:${String(source.offset)}:${String(source.endOffset)}`,
      );
      expect(new Set(ranges).size, `${result.id}/${ask.id} duplicate source range`).toBe(
        ranges.length,
      );
    }
  }
  const legacy = report.results.filter(
    (result) => result.variant === QuestionContextVariant.LEGACY,
  );
  expect(
    legacy.some((result) =>
      result.asks.some((ask) => ask.modelFacts.length < ask.requiredFacts.length),
    ),
  ).toBe(true);
  const formatted = formatQuestionContextEvaluation(report);
  expect(formatted).toContain('Model calls: 0');
  expect(formatted).toContain('Actual gateway requests: 0; provider calls: 0');
  expect(formatted).toContain('Actual inference cost: $0.000000');
  expect(formatted).toContain('these tokens were not sent to a provider or billed');
  expect(formatted).toContain(
    'Unknown live-run usage must not be replaced with these known local zeros',
  );
  expect(formatted).toContain('Estimated initial context tokens');
  expect(formatted).toContain('Initial context token estimate (unbilled)');
  expect(report.limitations.join(' ')).toContain('not a population success rate');
}, 30_000);
