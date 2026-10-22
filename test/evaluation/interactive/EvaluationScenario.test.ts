import { expect, it } from 'vitest';
import { DesktopLocale } from '../../../src/contracts/DesktopLocale.js';
import {
  EvaluationScenarioProvenanceKind,
  EvaluationScenarioSchema,
} from './EvaluationScenario.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';

it('accepts the two internal registered applications with their matching fixture and grader', () => {
  for (const application of ['vscode', 'scratch'] as const) {
    const scenario = getDefaultEvaluationScenario(application);
    expect(EvaluationScenarioSchema.parse(scenario)).toEqual(scenario);
    expect(scenario.application).toBe(application);
  }
  expect(getDefaultEvaluationScenario('vscode').locale).toBe(DesktopLocale.VIETNAMESE);
});

it('rejects executable setup, evaluator answers and incompatible application/fixture pairs', () => {
  const scenario = getDefaultEvaluationScenario('vscode');
  expect(
    EvaluationScenarioSchema.safeParse({ ...scenario, setup: 'arbitrary command' }).success,
  ).toBe(false);
  expect(
    EvaluationScenarioSchema.safeParse({ ...scenario, expectedSource: 'hidden answer' }).success,
  ).toBe(false);
  expect(
    EvaluationScenarioSchema.safeParse({ ...scenario, graderId: 'ScratchScore' }).success,
  ).toBe(false);
  expect(EvaluationScenarioSchema.safeParse({ ...scenario, application: 'scratch' }).success).toBe(
    false,
  );
  expect(EvaluationScenarioSchema.safeParse({ ...scenario, id: '../../private' }).success).toBe(
    false,
  );
});

it('requires generated provenance and bounds bytes as well as cursor positions', () => {
  const scenario = getDefaultEvaluationScenario('vscode');
  if (scenario.application !== 'vscode') {
    throw new Error('Expected Python case.');
  }
  expect(
    EvaluationScenarioSchema.safeParse({
      ...scenario,
      provenance: { ...scenario.provenance, kind: EvaluationScenarioProvenanceKind.GENERATED },
    }).success,
  ).toBe(false);
  expect(
    EvaluationScenarioSchema.safeParse({
      ...scenario,
      fixture: { ...scenario.fixture, cursor: { line: 128, column: 1 } },
    }).success,
  ).toBe(false);
  expect(
    EvaluationScenarioSchema.safeParse({
      ...scenario,
      fixture: { ...scenario.fixture, source: 'đ'.repeat(10_000), cursor: { line: 1, column: 1 } },
    }).success,
  ).toBe(false);
});
