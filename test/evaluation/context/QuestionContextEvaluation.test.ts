import { expect, it } from 'vitest';
import { ContextLimits } from '../../../src/contracts/StudyContext.js';
import { createQuestionContextCases } from './QuestionContextCases.js';
import {
  formatQuestionContextEvaluation,
  QuestionContextVariant,
  runQuestionContextEvaluation,
} from './QuestionContextEvaluation.js';

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
  const report = await runQuestionContextEvaluation({ includeThreeHour: false });
  expect(report.pairedCorpusDigestsMatch).toBe(true);
  expect(report.modelCalls).toBe(0);
  expect(report.embeddingCalls).toBe(0);
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
  expect(formatQuestionContextEvaluation(report)).toContain('Model calls: 0');
  expect(report.limitations.join(' ')).toContain('not a population success rate');
}, 30_000);
