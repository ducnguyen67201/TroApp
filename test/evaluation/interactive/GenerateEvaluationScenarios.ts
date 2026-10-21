import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DesktopLocale } from '../../../src/contracts/DesktopLocale.js';
import {
  EvaluationScenarioGrader,
  EvaluationScenarioApplication,
  EvaluationScenarioProvenanceKind,
  EvaluationScenarioSchema,
  type EvaluationScenario,
} from './EvaluationScenario.js';
import { PythonDebugCase } from './PythonDebugCase.js';
import { ScratchFixtureBug } from './ScratchProject.js';

export const PythonScenarioMutation = {
  MISSING_ELSE: 'MissingElse',
  MISINDENTED_ELSE: 'MisindentedElse',
  REVERSED_COMPARISON: 'ReversedComparison',
  MISSING_BREAK: 'MissingBreak',
} as const;

export interface GenerateEvaluationScenariosOptions {
  seed?: number;
  count?: number;
  application?: EvaluationScenarioApplication;
}

const GenerationOptionsSchema = z.strictObject({
  seed: z.number().int().min(0).max(0xffff_ffff).default(1),
  count: z.number().int().min(1).max(7).optional(),
  application: z.enum(EvaluationScenarioApplication).optional(),
});

/** This family uses the reviewed behavioral oracle, including changed-secret
 * probes. Source mutations stay within its supported subset and original 77. */
export function createRepairedPythonFixture(): string {
  return `${PythonDebugCase.startingSource.trimEnd()}\n    else:\n        print("Số bạn đoán lớn hơn số bí mật")\n`;
}

function createPythonCandidate(
  mutation: (typeof PythonScenarioMutation)[keyof typeof PythonScenarioMutation],
  seed: number,
): EvaluationScenario {
  let source = createRepairedPythonFixture();
  let request = '';
  let cursor = { line: 1, column: 1 };
  switch (mutation) {
    case PythonScenarioMutation.MISSING_ELSE:
      source = PythonDebugCase.startingSource;
      request = PythonDebugCase.request;
      cursor = { ...PythonDebugCase.startingCursor };
      break;
    case PythonScenarioMutation.MISINDENTED_ELSE:
      source = source.replace('    else:', '        else:');
      request =
        'Trò chơi đoán số của em báo lỗi ở nhánh cuối. Giúp em tìm nguyên nhân và sửa từng bước, rồi lưu để em chạy lại nhé.';
      cursor = { line: 9, column: 9 };
      break;
    case PythonScenarioMutation.REVERSED_COMPARISON:
      source = source.replace('doan < so_bi_mat', 'doan > so_bi_mat');
      request =
        'Khi em đoán số lớn hơn số bí mật thì chương trình lại báo nhỏ hơn. Giúp em tìm lỗi, hướng dẫn sửa và lưu chương trình nhé.';
      cursor = { line: 7, column: 10 };
      break;
    case PythonScenarioMutation.MISSING_BREAK:
      source = source.replace('        break\n', '');
      request =
        'Em đã đoán đúng số và thấy lời chúc mừng nhưng chương trình vẫn hỏi tiếp. Giúp em sửa lỗi và lưu chương trình nhé.';
      cursor = { line: 5, column: 9 };
      break;
  }
  return EvaluationScenarioSchema.parse({
    schemaVersion: 1,
    version: 1,
    id: `Python${mutation}Seed${String(seed)}`,
    title: `Python guessing game: ${mutation}`,
    application: EvaluationScenarioApplication.VSCODE,
    graderId: EvaluationScenarioGrader.PYTHON_GUESSING_GAME,
    request,
    historyText:
      'Em đang học câu lệnh điều kiện và vòng lặp, và viết trò chơi đoán số bằng Python trong VS Code.',
    locale: DesktopLocale.VIETNAMESE,
    fixture: { kind: 'python', source, cursor },
    provenance: {
      kind: EvaluationScenarioProvenanceKind.GENERATED,
      sourceId: 'PythonGuessingGameFamilyV1',
      seed,
      mutation,
    },
  });
}

function createScratchCandidate(
  bug: (typeof ScratchFixtureBug)[keyof typeof ScratchFixtureBug],
  seed: number,
): EvaluationScenario {
  const questions = {
    [ScratchFixtureBug.RESET_INSIDE_LOOP]:
      'My score should go up by one each turn. After three turns it should be 3, but it shows 1. Help me debug this.',
    [ScratchFixtureBug.MISSING_INCREMENT]:
      'My Scratch game repeats three turns, but the score stays at zero. Help me find the bug and fix it step by step.',
    [ScratchFixtureBug.WRONG_INCREMENT]:
      'My score should increase by one per turn. After three turns it shows 6 instead of 3. Help me debug the Scratch project.',
  };
  return EvaluationScenarioSchema.parse({
    schemaVersion: 1,
    version: 1,
    id: `Scratch${bug}Seed${String(seed)}`,
    title: `Scratch score: ${bug}`,
    application: EvaluationScenarioApplication.SCRATCH,
    graderId: EvaluationScenarioGrader.SCRATCH_SCORE,
    request: questions[bug],
    historyText: 'The score should start at zero and increase by one on each turn.',
    locale: DesktopLocale.ENGLISH,
    fixture: { kind: 'scratch', bug },
    provenance: {
      kind: EvaluationScenarioProvenanceKind.GENERATED,
      sourceId: 'ScratchScoreFamilyV1',
      seed,
      mutation: bug,
    },
  });
}

/** Automatic constrained generation makes no model request. The seed selects a
 * stable order among seven distinct reviewed mutation templates; it does not
 * turn paraphrases into additional independent exercise families. */
export function generateEvaluationScenarios(
  options: GenerateEvaluationScenariosOptions = {},
): EvaluationScenario[] {
  const parsed = GenerationOptionsSchema.parse(options);
  const candidates = [
    ...Object.values(PythonScenarioMutation).map((mutation) =>
      createPythonCandidate(mutation, parsed.seed),
    ),
    ...Object.values(ScratchFixtureBug).map((bug) => createScratchCandidate(bug, parsed.seed)),
  ].filter(
    (scenario) => parsed.application === undefined || scenario.application === parsed.application,
  );
  const count = parsed.count ?? candidates.length;
  if (count > candidates.length) {
    throw new Error('scenario_generation_count_exceeds_distinct_templates');
  }
  return candidates
    .map((scenario) => ({
      scenario,
      order: createHash('sha256')
        .update(`${String(parsed.seed)}:${scenario.id}`)
        .digest('hex'),
    }))
    .sort((first, second) => first.order.localeCompare(second.order))
    .slice(0, count)
    .map(({ scenario }) => scenario);
}
