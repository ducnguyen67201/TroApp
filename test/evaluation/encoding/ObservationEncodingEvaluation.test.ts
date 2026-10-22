import { afterEach, expect, it, vi } from 'vitest';
import { ModelObservationEncoding } from '../../../src/desktop/worker/agent/FormatModelObservation.js';
import {
  formatObservationEncodingEvaluation,
  runObservationEncodingEvaluation,
} from './ObservationEncodingEvaluation.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('uses the real adaptive formatter without provider calls and preserves every authored JSON value', () => {
  const fetchProvider = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('The encoding benchmark must stay offline.'));
  const report = runObservationEncodingEvaluation();
  expect(fetchProvider).not.toHaveBeenCalled();
  expect(report.actualUsage).toEqual({
    basis: 'no_provider_invocations',
    providerCalls: 0,
    modelCalls: 0,
    gatewayCalls: 0,
    embeddingCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    inferenceCostUsd: 0,
  });
  expect(report.results).toHaveLength(8);
  expect(report.allRoundtripsExact).toBe(true);
  expect(report.noTokenRegressions).toBe(true);
  for (const result of report.results) {
    expect(result.exactRoundtrip, result.id).toBe(true);
    expect(result.outputTokens, result.id).toBeLessThanOrEqual(result.jsonTokens);
    expect(result.outputTokenRatio, result.id).toBeLessThanOrEqual(1);
    expect(result.encodeAndSelectionMs, result.id).toBeGreaterThanOrEqual(0);
    if (result.selectedFormat === ModelObservationEncoding.TOON) {
      expect(result.outputTokens, result.id).toBe(result.guidedToonTokens);
      expect(result.rawToonTokens, result.id).toBeLessThan(result.guidedToonTokens);
    } else {
      expect(result.outputTokens, result.id).toBe(result.jsonTokens);
    }
  }
  const selectedFormat = (id: string) =>
    report.results.find((result) => result.id === id)?.selectedFormat;
  expect(selectedFormat('OneHundredUniformAccessibilityNodes')).toBe(ModelObservationEncoding.TOON);
  expect(selectedFormat('UniformQuotedEvidence')).toBe(ModelObservationEncoding.TOON);
  for (const id of [
    'SmallCaptureMetadata',
    'SingleWindow',
    'HeterogeneousAccessibilityTree',
    'TextHeavyAccessibilityObservation',
  ]) {
    expect(selectedFormat(id), id).toBe(ModelObservationEncoding.JSON);
  }
  expect(report.totals.savedTokens).toBeGreaterThan(0);
  expect(report.totals.jsonTokens).toBe(
    report.results.reduce((sum, result) => sum + result.jsonTokens, 0),
  );
  expect(report.totals.outputTokens).toBe(
    report.results.reduce((sum, result) => sum + result.outputTokens, 0),
  );
  expect(report.totals.toonCases + report.totals.jsonCases).toBe(report.results.length);
  const markdown = formatObservationEncodingEvaluation(report);
  expect(markdown).toContain('Exact roundtrips: PASS');
  expect(markdown).toContain('No text-token regressions: PASS');
  expect(markdown).toContain('Actual inference input/output tokens: 0');
  expect(markdown).toContain('Inference cost: $0.00');
  expect(markdown).toContain('not a provider bill');
  expect(markdown).toContain('Screenshots, images, JSON tool schemas');
});
