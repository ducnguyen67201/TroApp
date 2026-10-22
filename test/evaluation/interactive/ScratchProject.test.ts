import { strToU8, zipSync } from 'fflate';
import { expect, it } from 'vitest';
import {
  ScratchOpcode,
  ScratchFixtureBug,
  ScratchProjectLimits,
  ScratchProjectSchema,
  createScratchProjectArchive,
  createRepairedScratchProjectArchive,
  gradeScratchProject,
  parseScratchProjectArchive,
  readScratchScore,
  type ScratchBlock,
  type ScratchProject,
} from './ScratchProject.js';

function readSprite(project: ScratchProject): ScratchProject['targets'][number] {
  const target = project.targets.find((item) => !item.isStage);
  if (!target) {
    throw new Error('The authored sprite is missing.');
  }
  return target;
}

function readBlock(project: ScratchProject, id: string): ScratchBlock {
  const block = readSprite(project).blocks[id];
  if (!block || Array.isArray(block)) {
    throw new Error(`The authored statement ${id} is missing.`);
  }
  return block;
}

function createProject(): ScratchProject {
  return parseScratchProjectArchive(createScratchProjectArchive());
}

function moveResetBeforeLoop(project: ScratchProject): void {
  const hat = readBlock(project, 'WhenFlag');
  const reset = readBlock(project, 'ResetScore');
  const repeat = readBlock(project, 'RepeatTurns');
  const increment = readBlock(project, 'IncreaseScore');
  hat.next = 'ResetScore';
  reset.parent = 'WhenFlag';
  reset.next = 'RepeatTurns';
  repeat.parent = 'ResetScore';
  repeat.inputs['SUBSTACK'] = [2, 'IncreaseScore'];
  increment.parent = 'RepeatTurns';
}

function createArchive(value: unknown): Uint8Array {
  const text = JSON.stringify(value);
  return zipSync({ 'project.json': strToU8(text) });
}

it('creates a deterministic, ordinary Scratch 3 archive with a visible score and the real loop bug', () => {
  const archive = createScratchProjectArchive();
  expect(archive).toEqual(createScratchProjectArchive());
  const project = parseScratchProjectArchive(archive);
  expect(project.meta.semver).toBe('3.0.0');
  expect(readScratchScore(project)).toBe(0);
  expect(project.monitors).toHaveLength(1);
  expect(readBlock(project, 'ResetScore').parent).toBe('RepeatTurns');
  expect(gradeScratchProject(project)).toMatchObject({ supported: true, passed: false });
  expect(JSON.stringify(project)).not.toContain('before the loop');
  expect(JSON.stringify(project)).not.toContain('expectedState');
});

it.each(Object.values(ScratchFixtureBug))(
  'creates a supported unsolved %s starting project',
  (bug) => {
    const archive = createScratchProjectArchive(bug);
    expect(archive).toEqual(createScratchProjectArchive(bug));
    const project = parseScratchProjectArchive(archive);
    expect(readScratchScore(project)).toBe(0);
    expect(gradeScratchProject(project)).toMatchObject({ supported: true, passed: false });
    const serialized = JSON.stringify(project);
    expect(serialized).not.toContain('graderId');
    expect(serialized).not.toContain('referenceRepair');
  },
);

it('keeps calibration repairs separate from every selectable broken fixture', () => {
  const repaired = createRepairedScratchProjectArchive();
  expect(gradeScratchProject(parseScratchProjectArchive(repaired))).toEqual({
    supported: true,
    passed: true,
    reasons: [],
  });
  for (const bug of Object.values(ScratchFixtureBug)) {
    expect(createScratchProjectArchive(bug)).not.toEqual(repaired);
  }
});

it('independently accepts the exported graph after the reset moves before the loop', () => {
  const project = createProject();
  moveResetBeforeLoop(project);
  expect(gradeScratchProject(project)).toEqual({ supported: true, passed: true, reasons: [] });
  expect(gradeScratchProject(parseScratchProjectArchive(createArchive(project)))).toEqual({
    supported: true,
    passed: true,
    reasons: [],
  });
});

it('accepts a different valid initialization block and an unused detached original reset', () => {
  const project = createProject();
  const original = readBlock(project, 'ResetScore');
  const newReset: ScratchBlock = {
    ...original,
    parent: 'WhenFlag',
    next: 'RepeatTurns',
    topLevel: false,
  };
  readSprite(project).blocks['NewInitialization'] = newReset;
  readBlock(project, 'WhenFlag').next = 'NewInitialization';
  readBlock(project, 'RepeatTurns').parent = 'NewInitialization';
  readBlock(project, 'RepeatTurns').inputs['SUBSTACK'] = [2, 'IncreaseScore'];
  readBlock(project, 'IncreaseScore').parent = 'RepeatTurns';
  original.parent = null;
  original.topLevel = true;
  original.next = null;
  expect(gradeScratchProject(project).passed).toBe(true);
});

it('reads Scratch numeric shadow blocks without requiring compact primitive inputs', () => {
  const project = createProject();
  moveResetBeforeLoop(project);
  readSprite(project).blocks['ZeroNumber'] = {
    opcode: ScratchOpcode.NUMBER,
    next: null,
    parent: 'ResetScore',
    inputs: {},
    fields: { NUM: ['0'] },
    shadow: true,
    topLevel: false,
  };
  readBlock(project, 'ResetScore').inputs['VALUE'] = [1, 'ZeroNumber'];
  expect(gradeScratchProject(project).passed).toBe(true);
});

it('rejects a hardcoded three even when the displayed/exported value happens to be three', () => {
  const project = createProject();
  moveResetBeforeLoop(project);
  readBlock(project, 'ResetScore').inputs['VALUE'] = [1, [4, '3']];
  readBlock(project, 'IncreaseScore').inputs['VALUE'] = [1, [4, '0']];
  const stage = project.targets.find((target) => target.isStage);
  if (!stage) {
    throw new Error('Missing stage.');
  }
  stage.variables['TroScoreVariable'] = ['score', 3];
  expect(readScratchScore(project)).toBe(3);
  const grade = gradeScratchProject(project);
  expect(grade.supported).toBe(true);
  expect(grade.passed).toBe(false);
  expect(grade.reasons).toContain('score_behavior_mismatch:0:initial_0');
});

it('requires correct variable wiring rather than accepting edits to another variable', () => {
  const project = createProject();
  moveResetBeforeLoop(project);
  readSprite(project).variables['OtherVariable'] = ['other', 0];
  readBlock(project, 'ResetScore').fields['VARIABLE'] = ['other', 'OtherVariable'];
  readBlock(project, 'IncreaseScore').fields['VARIABLE'] = ['other', 'OtherVariable'];
  expect(gradeScratchProject(project)).toMatchObject({ supported: true, passed: false });
});

it('requires resetting on every green-flag run rather than relying on a convenient initial value', () => {
  const project = createProject();
  readBlock(project, 'RepeatTurns').inputs['SUBSTACK'] = [2, 'IncreaseScore'];
  readBlock(project, 'IncreaseScore').parent = 'RepeatTurns';
  delete readSprite(project).blocks['ResetScore'];
  const grade = gradeScratchProject(project);
  expect(grade.supported).toBe(true);
  expect(grade.passed).toBe(false);
  expect(grade.reasons).toContain('score_behavior_mismatch:3:initial_7');
});

it.each([
  'cycle',
  'wrong-parent',
  'unsupported-opcode',
  'missing-variable',
  'extra-green-flag',
  'unbounded-nested-repeat',
])('leaves %s programs unsupported instead of claiming they are wrong', (kind) => {
  const project = createProject();
  moveResetBeforeLoop(project);
  if (kind === 'cycle') {
    readBlock(project, 'IncreaseScore').next = 'RepeatTurns';
  } else if (kind === 'wrong-parent') {
    readBlock(project, 'IncreaseScore').parent = 'WhenFlag';
  } else if (kind === 'unsupported-opcode') {
    readBlock(project, 'IncreaseScore').opcode = 'looks_say';
  } else if (kind === 'missing-variable') {
    readBlock(project, 'IncreaseScore').fields['VARIABLE'] = ['score', 'MissingVariable'];
  } else if (kind === 'extra-green-flag') {
    readSprite(project).blocks['OtherHat'] = { ...readBlock(project, 'WhenFlag'), next: null };
  } else {
    readBlock(project, 'RepeatTurns').inputs['SUBSTACK'] = [2, 'NestedRepeat'];
    readSprite(project).blocks['NestedRepeat'] = {
      opcode: ScratchOpcode.REPEAT,
      next: null,
      parent: 'RepeatTurns',
      inputs: { TIMES: [1, [6, '10000']], SUBSTACK: [2, 'IncreaseScore'] },
      fields: {},
      shadow: false,
      topLevel: false,
    };
    readBlock(project, 'IncreaseScore').parent = 'NestedRepeat';
  }
  expect(gradeScratchProject(project)).toMatchObject({ supported: false, passed: false });
});

it('requires the authored three-turn loop and the global score variable', () => {
  const project = createProject();
  moveResetBeforeLoop(project);
  readBlock(project, 'RepeatTurns').inputs['TIMES'] = [1, [6, '5']];
  expect(gradeScratchProject(project)).toEqual({
    supported: true,
    passed: false,
    reasons: ['repeat_count_is_not_three'],
  });
  const stage = project.targets.find((target) => target.isStage);
  if (!stage) {
    throw new Error('Missing stage.');
  }
  delete stage.variables['TroScoreVariable'];
  expect(gradeScratchProject(project)).toEqual({
    supported: true,
    passed: false,
    reasons: ['missing_or_ambiguous_global_score'],
  });
});

it('bounds compressed input and declared project expansion before allocating it', () => {
  expect(() =>
    parseScratchProjectArchive(new Uint8Array(ScratchProjectLimits.ARCHIVE_BYTES + 1)),
  ).toThrow('scratch_archive_too_large');
  const oversized = zipSync({
    'project.json': strToU8(' '.repeat(ScratchProjectLimits.PROJECT_BYTES + 1)),
  });
  expect(oversized.byteLength).toBeLessThan(ScratchProjectLimits.ARCHIVE_BYTES);
  expect(() => parseScratchProjectArchive(oversized)).toThrow('scratch_archive_invalid');
});

it.each([
  'missing',
  'malformed-zip',
  'malformed-json',
  'wrong-schema',
  'path-trick',
  'too-many-blocks',
])('rejects %s archives without exposing their raw content', (kind) => {
  let archive: Uint8Array;
  if (kind === 'missing') {
    archive = zipSync({ 'not-project.json': strToU8('{}') });
  } else if (kind === 'malformed-zip') {
    archive = strToU8('not a zip');
  } else if (kind === 'malformed-json') {
    archive = zipSync({ 'project.json': strToU8('private malformed content') });
  } else if (kind === 'wrong-schema') {
    archive = createArchive({ targets: [] });
  } else if (kind === 'path-trick') {
    archive = zipSync({
      'project.json': strToU8(JSON.stringify(createProject())),
      '../project.json': strToU8('{}'),
    });
  } else {
    const project = createProject();
    for (let index = 0; index <= ScratchProjectLimits.BLOCKS; index += 1) {
      readSprite(project).blocks[`Extra${String(index)}`] = {
        ...readBlock(project, 'WhenFlag'),
        next: null,
      };
    }
    expect(ScratchProjectSchema.safeParse(project).success).toBe(false);
    archive = createArchive(project);
  }
  expect(() => parseScratchProjectArchive(archive)).toThrow(/^scratch_/);
});

it('rejects duplicate project.json entries rather than silently taking the last copy', () => {
  const projectBytes = strToU8(JSON.stringify(createProject()));
  const archive = zipSync(
    { 'project.json': projectBytes, 'Project.json': projectBytes },
    { level: 0 },
  );
  const alternateName = strToU8('Project.json');
  for (let index = 0; index <= archive.length - alternateName.length; index += 1) {
    if (alternateName.every((byte, offset) => archive[index + offset] === byte)) {
      archive[index] = 'p'.charCodeAt(0);
    }
  }
  expect(() => parseScratchProjectArchive(archive)).toThrow('scratch_archive_invalid');
});
