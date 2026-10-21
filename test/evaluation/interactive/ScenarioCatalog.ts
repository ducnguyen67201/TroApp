import { createHash } from 'node:crypto';
import { DesktopLocale } from '../../../src/contracts/DesktopLocale.js';
import { InteractiveTaskId } from './InteractiveStudyWorkspace.js';
import {
  EvaluationScenarioGrader,
  EvaluationScenarioApplication,
  EvaluationScenarioProvenanceKind,
  EvaluationScenarioSchema,
  type EvaluationScenario,
} from './EvaluationScenario.js';
import { PythonDebugCase } from './PythonDebugCase.js';
import { ScratchFixtureBug, createScratchProjectArchive } from './ScratchProject.js';

/** Return a fresh validated case so trial-local mutations cannot alter the catalog. */
export function getDefaultEvaluationScenario(
  application: EvaluationScenarioApplication,
): EvaluationScenario {
  if (application === EvaluationScenarioApplication.VSCODE) {
    return EvaluationScenarioSchema.parse({
      schemaVersion: 1,
      version: 1,
      id: 'PythonMissingGreaterBranch',
      title: 'Debug missing greater-number feedback',
      application,
      graderId: EvaluationScenarioGrader.PYTHON_GUESSING_GAME,
      request: PythonDebugCase.request,
      historyText: PythonDebugCase.historyText,
      locale: DesktopLocale.VIETNAMESE,
      fixture: {
        kind: 'python',
        source: PythonDebugCase.startingSource,
        cursor: PythonDebugCase.startingCursor,
      },
      provenance: {
        kind: EvaluationScenarioProvenanceKind.CUSTOMER_RECONSTRUCTION,
        sourceId: 'CustomerPythonVideo20261021',
        seed: null,
        mutation: null,
      },
    });
  }
  return EvaluationScenarioSchema.parse({
    schemaVersion: 1,
    version: 1,
    id: 'ScratchScoreResetsEachTurn',
    title: 'Debug a Scratch score that resets every turn',
    application,
    graderId: EvaluationScenarioGrader.SCRATCH_SCORE,
    request:
      'My score should go up by one each turn. After three turns it should be 3, but it shows 1. Help me debug this.',
    historyText: '',
    locale: DesktopLocale.ENGLISH,
    fixture: { kind: 'scratch', bug: ScratchFixtureBug.RESET_INSIDE_LOOP },
    provenance: {
      kind: EvaluationScenarioProvenanceKind.AUTHORED,
      sourceId: 'ScratchScoreExercise',
      seed: null,
      mutation: null,
    },
  });
}

export function getEvaluationTaskId(
  scenario: EvaluationScenario,
): typeof InteractiveTaskId.DEBUG_PYTHON | typeof InteractiveTaskId.DEBUG_SCORE {
  return scenario.application === EvaluationScenarioApplication.VSCODE
    ? InteractiveTaskId.DEBUG_PYTHON
    : InteractiveTaskId.DEBUG_SCORE;
}

/** Fixture identity excludes the question, case ID and cursor so cosmetic
 * paraphrases cannot be counted as additional distinct programming problems. */
export function readEvaluationFixtureDigest(scenarioInput: EvaluationScenario): string {
  const scenario = EvaluationScenarioSchema.parse(scenarioInput);
  const content =
    scenario.application === EvaluationScenarioApplication.VSCODE
      ? scenario.fixture.source.replaceAll('\r\n', '\n').trimEnd()
      : createScratchProjectArchive(scenario.fixture.bug);
  return createHash('sha256').update(content).digest('hex');
}

export function readEvaluationScenarioDigest(scenarioInput: EvaluationScenario): string {
  const scenario = EvaluationScenarioSchema.parse(scenarioInput);
  return createHash('sha256').update(JSON.stringify(scenario)).digest('hex');
}
