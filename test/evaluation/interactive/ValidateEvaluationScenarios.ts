import {
  EvaluationScenarioLimits,
  EvaluationScenarioApplication,
  EvaluationScenarioSchema,
  type EvaluationScenario,
} from './EvaluationScenario.js';
import {
  createRepairedPythonFixture,
  generateEvaluationScenarios,
} from './GenerateEvaluationScenarios.js';
import { gradePythonDebugSource } from './PythonDebugCase.js';
import {
  ScratchOpcode,
  createRepairedScratchProjectArchive,
  createScratchProjectArchive,
  gradeScratchProject,
  parseScratchProjectArchive,
  type ScratchBlock,
  type ScratchProject,
} from './ScratchProject.js';
import { readEvaluationFixtureDigest, readEvaluationScenarioDigest } from './ScenarioCatalog.js';

export const ScenarioValidationStatus = {
  PASS: 'pass',
  FAIL: 'fail',
  UNASSESSED: 'unassessed',
} as const;

export const ScenarioValidationCheck = {
  SCHEMA: 'schema',
  UNIQUE_ID: 'unique_id',
  UNIQUE_FIXTURE: 'unique_fixture',
  REGISTERED_FIXTURE: 'registered_fixture',
  INITIAL_BUG: 'initial_bug',
  REFERENCE_REPAIR: 'reference_repair',
  ALTERNATIVE_REPAIR: 'alternative_repair',
  WRONG_REPAIR: 'wrong_repair',
} as const;

export interface EvaluationScenarioValidationCheck {
  id: (typeof ScenarioValidationCheck)[keyof typeof ScenarioValidationCheck];
  status: (typeof ScenarioValidationStatus)[keyof typeof ScenarioValidationStatus];
  reason: string;
}

export interface EvaluationScenarioValidation {
  id: string | null;
  application: EvaluationScenario['application'] | null;
  scenarioDigest: string | null;
  fixtureDigest: string | null;
  passed: boolean;
  checks: EvaluationScenarioValidationCheck[];
}

export interface EvaluationScenarioValidationReport {
  schemaVersion: 1;
  passed: boolean;
  scenarios: EvaluationScenarioValidation[];
  modelCalls: 0;
}

interface ProgramGrade {
  supported: boolean;
  passed: boolean;
}

function createCheck(
  id: EvaluationScenarioValidationCheck['id'],
  passed: boolean,
  reason: string,
): EvaluationScenarioValidationCheck {
  return {
    id,
    status: passed ? ScenarioValidationStatus.PASS : ScenarioValidationStatus.FAIL,
    reason,
  };
}

function gradeExpectedOutcome(
  id: EvaluationScenarioValidationCheck['id'],
  grade: ProgramGrade,
  expectedPass: boolean,
): EvaluationScenarioValidationCheck {
  if (!grade.supported) {
    return {
      id,
      status: ScenarioValidationStatus.UNASSESSED,
      reason: 'program_outside_registered_grader_subset',
    };
  }
  return createCheck(
    id,
    grade.passed === expectedPass,
    grade.passed === expectedPass
      ? expectedPass
        ? 'known_valid_repair_passes'
        : 'known_bug_or_wrong_repair_fails'
      : expectedPass
        ? 'known_valid_repair_rejected'
        : 'bug_or_wrong_repair_was_accepted',
  );
}

function readScratchBlock(project: ScratchProject, id: string): ScratchBlock {
  const target = project.targets.find((item) => !item.isStage);
  const block = target?.blocks[id];
  if (!target || !block || Array.isArray(block)) {
    throw new Error('scenario_calibration_fixture_unavailable');
  }
  return block;
}

function createAlternativeScratchRepair(): ScratchProject {
  const project = parseScratchProjectArchive(createRepairedScratchProjectArchive());
  const target = project.targets.find((item) => !item.isStage);
  if (!target) {
    throw new Error('scenario_calibration_fixture_unavailable');
  }
  const reset = readScratchBlock(project, 'ResetScore');
  target.blocks['AlternativeInitialization'] = {
    ...reset,
    inputs: { ...reset.inputs },
    fields: { ...reset.fields },
  };
  readScratchBlock(project, 'WhenFlag').next = 'AlternativeInitialization';
  readScratchBlock(project, 'RepeatTurns').parent = 'AlternativeInitialization';
  reset.next = null;
  reset.parent = null;
  reset.topLevel = true;
  return project;
}

function createWrongScratchRepair(): ScratchProject {
  const project = parseScratchProjectArchive(createRepairedScratchProjectArchive());
  const increment = readScratchBlock(project, 'IncreaseScore');
  if (increment.opcode !== ScratchOpcode.CHANGE_VARIABLE) {
    throw new Error('scenario_calibration_fixture_unavailable');
  }
  increment.inputs['VALUE'] = [1, [4, '2']];
  return project;
}

function calibrateScenario(scenario: EvaluationScenario): EvaluationScenarioValidationCheck[] {
  if (scenario.application === EvaluationScenarioApplication.VSCODE) {
    const repair = createRepairedPythonFixture();
    return [
      gradeExpectedOutcome(
        ScenarioValidationCheck.INITIAL_BUG,
        gradePythonDebugSource(scenario.fixture.source),
        false,
      ),
      gradeExpectedOutcome(
        ScenarioValidationCheck.REFERENCE_REPAIR,
        gradePythonDebugSource(repair),
        true,
      ),
      gradeExpectedOutcome(
        ScenarioValidationCheck.ALTERNATIVE_REPAIR,
        gradePythonDebugSource(repair.replace('    else:', '    elif doan > so_bi_mat:')),
        true,
      ),
      gradeExpectedOutcome(
        ScenarioValidationCheck.WRONG_REPAIR,
        gradePythonDebugSource(
          repair.replace('Số bạn đoán lớn hơn số bí mật', 'Số bạn đoán nhỏ hơn số bí mật'),
        ),
        false,
      ),
    ];
  }
  return [
    gradeExpectedOutcome(
      ScenarioValidationCheck.INITIAL_BUG,
      gradeScratchProject(
        parseScratchProjectArchive(createScratchProjectArchive(scenario.fixture.bug)),
      ),
      false,
    ),
    gradeExpectedOutcome(
      ScenarioValidationCheck.REFERENCE_REPAIR,
      gradeScratchProject(parseScratchProjectArchive(createRepairedScratchProjectArchive())),
      true,
    ),
    gradeExpectedOutcome(
      ScenarioValidationCheck.ALTERNATIVE_REPAIR,
      gradeScratchProject(createAlternativeScratchRepair()),
      true,
    ),
    gradeExpectedOutcome(
      ScenarioValidationCheck.WRONG_REPAIR,
      gradeScratchProject(createWrongScratchRepair()),
      false,
    ),
  ];
}

function isRegisteredFixture(scenario: EvaluationScenario): boolean {
  if (scenario.application === EvaluationScenarioApplication.SCRATCH) {
    return true;
  }
  const source = scenario.fixture.source.replaceAll('\r\n', '\n').trimEnd();
  return generateEvaluationScenarios({
    seed: 1,
    application: EvaluationScenarioApplication.VSCODE,
  }).some(
    (candidate) =>
      candidate.application === EvaluationScenarioApplication.VSCODE &&
      candidate.fixture.source.replaceAll('\r\n', '\n').trimEnd() === source,
  );
}

/** Local calibration uses the registered bounded interpreters. It never executes
 * submitted Python, generated grader code, a GUI, or an inference request.
 * Passing calibration verifies the mechanical oracle; it is not teacher review
 * of the natural-language question or evidence of a student's understanding. */
export function validateEvaluationScenarios(
  inputs: readonly unknown[],
): EvaluationScenarioValidationReport {
  if (inputs.length === 0 || inputs.length > EvaluationScenarioLimits.SCENARIOS) {
    return {
      schemaVersion: 1,
      passed: false,
      modelCalls: 0,
      scenarios: [
        {
          id: null,
          application: null,
          scenarioDigest: null,
          fixtureDigest: null,
          passed: false,
          checks: [
            createCheck(ScenarioValidationCheck.SCHEMA, false, 'scenario_collection_size_invalid'),
          ],
        },
      ],
    };
  }
  const identifiers = new Set<string>();
  const fixtures = new Set<string>();
  const scenarios = inputs.map((input): EvaluationScenarioValidation => {
    const parsed = EvaluationScenarioSchema.safeParse(input);
    if (!parsed.success) {
      return {
        id: null,
        application: null,
        scenarioDigest: null,
        fixtureDigest: null,
        passed: false,
        checks: [createCheck(ScenarioValidationCheck.SCHEMA, false, 'scenario_schema_invalid')],
      };
    }
    const scenario = parsed.data;
    const fixtureDigest = readEvaluationFixtureDigest(scenario);
    const scenarioDigest = readEvaluationScenarioDigest(scenario);
    const registered = isRegisteredFixture(scenario);
    const checks: EvaluationScenarioValidationCheck[] = [
      createCheck(ScenarioValidationCheck.SCHEMA, true, 'scenario_schema_valid'),
      createCheck(
        ScenarioValidationCheck.UNIQUE_ID,
        !identifiers.has(scenario.id),
        identifiers.has(scenario.id) ? 'scenario_id_duplicated' : 'scenario_id_unique',
      ),
      createCheck(
        ScenarioValidationCheck.UNIQUE_FIXTURE,
        !fixtures.has(fixtureDigest),
        fixtures.has(fixtureDigest) ? 'starting_fixture_duplicated' : 'starting_fixture_unique',
      ),
      createCheck(
        ScenarioValidationCheck.REGISTERED_FIXTURE,
        registered,
        registered
          ? 'fixture_matches_registered_family'
          : 'fixture_requires_registered_family_review',
      ),
      ...calibrateScenario(scenario),
    ];
    identifiers.add(scenario.id);
    fixtures.add(fixtureDigest);
    return {
      id: scenario.id,
      application: scenario.application,
      scenarioDigest,
      fixtureDigest,
      passed: checks.every((check) => check.status === ScenarioValidationStatus.PASS),
      checks,
    };
  });
  return {
    schemaVersion: 1,
    passed: scenarios.every((scenario) => scenario.passed),
    scenarios,
    modelCalls: 0,
  };
}

export function formatEvaluationScenarioValidation(
  report: EvaluationScenarioValidationReport,
): string {
  const lines = [
    '# Internal scenario validation',
    '',
    `Result: ${report.passed ? 'PASS' : 'FAIL'}. Model calls: 0.`,
    '',
    'Mechanical calibration is separate from teacher review and learner understanding.',
    '',
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `## ${scenario.id ?? 'Invalid scenario'}: ${scenario.passed ? 'PASS' : 'FAIL'}`,
      '',
      '| Check | Result | Reason |',
      '| --- | --- | --- |',
    );
    for (const check of scenario.checks) {
      lines.push(`| ${check.id} | ${check.status.toUpperCase()} | ${check.reason} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
