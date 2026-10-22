import { expect, it } from 'vitest';
import { EvaluationScenarioProvenanceKind } from './EvaluationScenario.js';
import { generateEvaluationScenarios } from './GenerateEvaluationScenarios.js';
import { readEvaluationFixtureDigest } from './ScenarioCatalog.js';

it('generates a reproducible collection of seven distinct bug fixtures without inference', () => {
  const first = generateEvaluationScenarios({ seed: 42 });
  expect(first).toEqual(generateEvaluationScenarios({ seed: 42 }));
  expect(first).toHaveLength(7);
  expect(new Set(first.map(readEvaluationFixtureDigest)).size).toBe(7);
  expect(first.filter((scenario) => scenario.application === 'vscode')).toHaveLength(4);
  expect(first.filter((scenario) => scenario.application === 'scratch')).toHaveLength(3);
  expect(
    first.every(
      (scenario) =>
        scenario.provenance.kind === EvaluationScenarioProvenanceKind.GENERATED &&
        scenario.provenance.seed === 42,
    ),
  ).toBe(true);
  expect(JSON.stringify(first)).not.toContain('expectedSource');
  expect(JSON.stringify(first)).not.toContain('referenceRepair');
});

it('selects bounded application-specific subsets and does not inflate the finite templates', () => {
  expect(generateEvaluationScenarios({ seed: 0, application: 'vscode' })).toHaveLength(4);
  expect(generateEvaluationScenarios({ seed: 0, application: 'scratch', count: 2 })).toHaveLength(
    2,
  );
  expect(generateEvaluationScenarios({ seed: 5, count: 1 })).toHaveLength(1);
  expect(() => generateEvaluationScenarios({ application: 'scratch', count: 4 })).toThrow(
    'scenario_generation_count_exceeds_distinct_templates',
  );
  expect(() => generateEvaluationScenarios({ count: 8 })).toThrow();
  expect(() => generateEvaluationScenarios({ seed: -1 })).toThrow();
  expect(() => generateEvaluationScenarios({ seed: Number.NaN })).toThrow();
});
