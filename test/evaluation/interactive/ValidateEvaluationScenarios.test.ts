import { expect, it } from 'vitest';
import {
  generateEvaluationScenarios,
  createRepairedPythonFixture,
} from './GenerateEvaluationScenarios.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';
import {
  ScenarioValidationCheck,
  ScenarioValidationStatus,
  formatEvaluationScenarioValidation,
  validateEvaluationScenarios,
} from './ValidateEvaluationScenarios.js';

it('calibrates all generated fixtures against independent valid, alternative and wrong controls', () => {
  const report = validateEvaluationScenarios(generateEvaluationScenarios({ seed: 73 }));
  expect(report.passed).toBe(true);
  expect(report.modelCalls).toBe(0);
  expect(report.scenarios).toHaveLength(7);
  expect(
    report.scenarios.every(
      (scenario) =>
        scenario.checks.length === 8 &&
        scenario.checks.every((check) => check.status === ScenarioValidationStatus.PASS),
    ),
  ).toBe(true);
  expect(formatEvaluationScenarioValidation(report)).toContain('Model calls: 0');
  expect(formatEvaluationScenarioValidation(report)).toContain(
    'Mechanical calibration is separate from teacher review',
  );
});

it('accepts the current customer reconstruction and authored Scratch seed', () => {
  expect(
    validateEvaluationScenarios([
      getDefaultEvaluationScenario('vscode'),
      getDefaultEvaluationScenario('scratch'),
    ]).passed,
  ).toBe(true);
});

it('rejects an already solved initial fixture and unrelated broken programs', () => {
  const scenario = getDefaultEvaluationScenario('vscode');
  if (scenario.application !== 'vscode') {
    throw new Error('Expected Python case.');
  }
  const solved = validateEvaluationScenarios([
    { ...scenario, fixture: { ...scenario.fixture, source: createRepairedPythonFixture() } },
  ]);
  expect(solved.passed).toBe(false);
  expect(solved.scenarios[0]?.checks).toContainEqual({
    id: ScenarioValidationCheck.INITIAL_BUG,
    status: ScenarioValidationStatus.FAIL,
    reason: 'bug_or_wrong_repair_was_accepted',
  });
  const unrelated = validateEvaluationScenarios([
    {
      ...scenario,
      fixture: {
        kind: 'python',
        source: 'print("another exercise")\n',
        cursor: { line: 1, column: 1 },
      },
    },
  ]);
  expect(unrelated.passed).toBe(false);
  expect(unrelated.scenarios[0]?.checks).toContainEqual({
    id: ScenarioValidationCheck.REGISTERED_FIXTURE,
    status: ScenarioValidationStatus.FAIL,
    reason: 'fixture_requires_registered_family_review',
  });
});

it('retains unsupported syntax as unassessed and never treats it as a known broken example', () => {
  const scenario = getDefaultEvaluationScenario('vscode');
  const report = validateEvaluationScenarios([
    {
      ...scenario,
      fixture: { kind: 'python', source: 'import os\n', cursor: { line: 1, column: 1 } },
    },
  ]);
  expect(report.passed).toBe(false);
  expect(report.scenarios[0]?.checks).toContainEqual({
    id: ScenarioValidationCheck.INITIAL_BUG,
    status: ScenarioValidationStatus.UNASSESSED,
    reason: 'program_outside_registered_grader_subset',
  });
});

it('rejects duplicate IDs and duplicate fixtures even when their questions differ', () => {
  const first = getDefaultEvaluationScenario('vscode');
  const report = validateEvaluationScenarios([
    first,
    first,
    { ...first, id: 'DifferentQuestion', request: 'Another wording' },
  ]);
  expect(report.passed).toBe(false);
  expect(report.scenarios[1]?.checks).toContainEqual({
    id: ScenarioValidationCheck.UNIQUE_ID,
    status: ScenarioValidationStatus.FAIL,
    reason: 'scenario_id_duplicated',
  });
  expect(report.scenarios[2]?.checks).toContainEqual({
    id: ScenarioValidationCheck.UNIQUE_FIXTURE,
    status: ScenarioValidationStatus.FAIL,
    reason: 'starting_fixture_duplicated',
  });
});

it('fails closed on invalid manifests and bounded collection sizes without echoing raw input', () => {
  expect(validateEvaluationScenarios([]).passed).toBe(false);
  expect(validateEvaluationScenarios(Array.from({ length: 33 }, () => null)).passed).toBe(false);
  const report = validateEvaluationScenarios([{ secret: 'never include private input' }]);
  expect(report.passed).toBe(false);
  expect(JSON.stringify(report)).not.toContain('never include private input');
});
