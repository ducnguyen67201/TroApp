import { expect, it } from 'vitest';
import { InteractiveTaskId } from './InteractiveStudyWorkspace.js';
import {
  getDefaultEvaluationScenario,
  getEvaluationTaskId,
  readEvaluationFixtureDigest,
  readEvaluationScenarioDigest,
} from './ScenarioCatalog.js';

it('keeps public scenario IDs separate from the legacy workspace task selector', () => {
  expect(getEvaluationTaskId(getDefaultEvaluationScenario('vscode'))).toBe(
    InteractiveTaskId.DEBUG_PYTHON,
  );
  expect(getEvaluationTaskId(getDefaultEvaluationScenario('scratch'))).toBe(
    InteractiveTaskId.DEBUG_SCORE,
  );
});

it('does not leak the customer repair notes and returns fresh catalog data', () => {
  const first = getDefaultEvaluationScenario('vscode');
  const next = getDefaultEvaluationScenario('vscode');
  first.request = 'Changed locally';
  expect(next.request).not.toBe(first.request);
  expect(JSON.stringify(next)).not.toContain('observedGuidance');
  expect(JSON.stringify(next)).not.toContain('Dedent');
  expect(JSON.stringify(next)).not.toContain('else with');
});

it('distinguishes case metadata from fixture identity and hashes archives deterministically', () => {
  const first = getDefaultEvaluationScenario('vscode');
  const paraphrase = {
    ...first,
    id: 'ParaphrasedQuestion',
    request: 'Another wording of the same problem',
  };
  expect(readEvaluationFixtureDigest(first)).toBe(readEvaluationFixtureDigest(paraphrase));
  expect(readEvaluationScenarioDigest(first)).not.toBe(readEvaluationScenarioDigest(paraphrase));
  const scratch = getDefaultEvaluationScenario('scratch');
  expect(readEvaluationFixtureDigest(scratch)).toBe(readEvaluationFixtureDigest(scratch));
  expect(readEvaluationFixtureDigest(scratch)).toMatch(/^[a-f0-9]{64}$/);
});
