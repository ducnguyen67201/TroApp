import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';

export const ScratchProjectLimits = {
  ARCHIVE_BYTES: 5 * 1024 * 1024,
  PROJECT_BYTES: 500 * 1024,
  ARCHIVE_ENTRIES: 256,
  BLOCKS: 1000,
  STEPS: 10_000,
  VALUE: 1_000_000,
  REPEAT: 20,
} as const;

export const ScratchOpcode = {
  GREEN_FLAG: 'event_whenflagclicked',
  REPEAT: 'control_repeat',
  SET_VARIABLE: 'data_setvariableto',
  CHANGE_VARIABLE: 'data_changevariableby',
  NUMBER: 'math_number',
  WHOLE_NUMBER: 'math_whole_number',
  POSITIVE_NUMBER: 'math_positive_number',
  INTEGER: 'math_integer',
  ANGLE: 'math_angle',
} as const;

/** Registered fixture mutations are data, never executable setup scripts. */
export const ScratchFixtureBug = {
  RESET_INSIDE_LOOP: 'ResetInsideLoop',
  MISSING_INCREMENT: 'MissingIncrement',
  WRONG_INCREMENT: 'WrongIncrement',
} as const;

export type ScratchFixtureBug = (typeof ScratchFixtureBug)[keyof typeof ScratchFixtureBug];

const IdentifierSchema = z.string().min(1).max(256);
const ScalarSchema = z.union([z.string().max(10_000), z.number(), z.boolean()]);
const PrimitiveSchema = z.tuple([z.number().int().min(4).max(13)]).rest(ScalarSchema);
const FieldSchema = z.union([
  z.tuple([ScalarSchema]),
  z.tuple([ScalarSchema, IdentifierSchema.nullable()]),
]);
const InputValueSchema = z.union([IdentifierSchema, PrimitiveSchema, z.null()]);
const InputSchema = z.union([
  z.tuple([z.number().int().min(1).max(3), InputValueSchema]),
  z.tuple([z.number().int().min(1).max(3), InputValueSchema, InputValueSchema]),
]);

export const ScratchBlockSchema = z.looseObject({
  opcode: z.string().min(1).max(128),
  next: IdentifierSchema.nullable(),
  parent: IdentifierSchema.nullable(),
  inputs: z.record(IdentifierSchema, InputSchema),
  fields: z.record(IdentifierSchema, FieldSchema),
  shadow: z.boolean(),
  topLevel: z.boolean(),
  x: z.number().optional(),
  y: z.number().optional(),
});

export type ScratchBlock = z.infer<typeof ScratchBlockSchema>;

const VariableSchema = z.union([
  z.tuple([z.string().max(256), ScalarSchema]),
  z.tuple([z.string().max(256), ScalarSchema, z.boolean()]),
]);
const TargetSchema = z.looseObject({
  isStage: z.boolean(),
  name: z.string().max(256),
  variables: z.record(IdentifierSchema, VariableSchema),
  blocks: z.record(IdentifierSchema, z.union([ScratchBlockSchema, PrimitiveSchema])),
});

/** This is the bounded, actual project.json exported by Scratch. Unknown metadata
 * is preserved for replay; the evaluator reads only validated program fields. */
export const ScratchProjectSchema = z
  .looseObject({
    targets: z.array(TargetSchema).min(1).max(10),
    monitors: z.array(z.unknown()).max(100),
    extensions: z.array(z.string().max(128)).max(30),
    meta: z.looseObject({ semver: z.string().max(64) }),
  })
  .superRefine((project, context) => {
    if (
      project.targets.reduce((sum, target) => sum + Object.keys(target.blocks).length, 0) >
      ScratchProjectLimits.BLOCKS
    ) {
      context.addIssue({ code: 'custom', message: 'The Scratch project exceeds the block limit.' });
    }
    if (project.targets.filter((target) => target.isStage).length !== 1) {
      context.addIssue({ code: 'custom', message: 'A Scratch project requires one stage.' });
    }
  });

export type ScratchProject = z.infer<typeof ScratchProjectSchema>;
type ScratchTarget = ScratchProject['targets'][number];
type ScratchInputValue = z.infer<typeof InputValueSchema>;

const FixtureScoreId = 'TroScoreVariable';
const NumberOpcodes = new Set<string>([
  ScratchOpcode.NUMBER,
  ScratchOpcode.WHOLE_NUMBER,
  ScratchOpcode.POSITIVE_NUMBER,
  ScratchOpcode.INTEGER,
  ScratchOpcode.ANGLE,
]);

function createBlock(
  opcode: ScratchBlock['opcode'],
  next: string | null,
  parent: string | null,
  inputs: ScratchBlock['inputs'] = {},
  fields: ScratchBlock['fields'] = {},
): ScratchBlock {
  return { opcode, next, parent, inputs, fields, shadow: false, topLevel: parent === null };
}

/** Authored input only. No expected answer, repair instruction or rubric is included
 * in this ordinary Scratch archive. Asset filenames follow Scratch's MD5 convention. */
function createAuthoredScratchProjectArchive(bug: ScratchFixtureBug | null): Uint8Array {
  const backdrop =
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="white"/></svg>';
  const sprite =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#ffab19" stroke="#c77d00" stroke-width="3"/></svg>';
  const backdropId = createHash('md5').update(backdrop).digest('hex');
  const spriteId = createHash('md5').update(sprite).digest('hex');
  const project = ScratchProjectSchema.parse({
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: { [FixtureScoreId]: ['score', 0] },
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [
          {
            assetId: backdropId,
            name: 'backdrop1',
            md5ext: `${backdropId}.svg`,
            dataFormat: 'svg',
            rotationCenterX: 240,
            rotationCenterY: 180,
          },
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
        textToSpeechLanguage: null,
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {
          WhenFlag: {
            ...createBlock(
              ScratchOpcode.GREEN_FLAG,
              bug === ScratchFixtureBug.RESET_INSIDE_LOOP ? 'RepeatTurns' : 'ResetScore',
              null,
            ),
            x: 80,
            y: 80,
          },
          RepeatTurns: createBlock(
            ScratchOpcode.REPEAT,
            null,
            bug === ScratchFixtureBug.RESET_INSIDE_LOOP ? 'WhenFlag' : 'ResetScore',
            {
              TIMES: [1, [6, '3']],
              SUBSTACK: [
                2,
                bug === ScratchFixtureBug.RESET_INSIDE_LOOP
                  ? 'ResetScore'
                  : bug === ScratchFixtureBug.MISSING_INCREMENT
                    ? null
                    : 'IncreaseScore',
              ],
            },
          ),
          ResetScore: createBlock(
            ScratchOpcode.SET_VARIABLE,
            bug === ScratchFixtureBug.RESET_INSIDE_LOOP ? 'IncreaseScore' : 'RepeatTurns',
            bug === ScratchFixtureBug.RESET_INSIDE_LOOP ? 'RepeatTurns' : 'WhenFlag',
            { VALUE: [1, [4, '0']] },
            { VARIABLE: ['score', FixtureScoreId] },
          ),
          IncreaseScore: createBlock(
            ScratchOpcode.CHANGE_VARIABLE,
            null,
            bug === ScratchFixtureBug.RESET_INSIDE_LOOP
              ? 'ResetScore'
              : bug === ScratchFixtureBug.MISSING_INCREMENT
                ? null
                : 'RepeatTurns',
            { VALUE: [1, [4, bug === ScratchFixtureBug.WRONG_INCREMENT ? '2' : '1']] },
            { VARIABLE: ['score', FixtureScoreId] },
          ),
        },
        comments: {},
        currentCostume: 0,
        costumes: [
          {
            assetId: spriteId,
            name: 'costume1',
            bitmapResolution: 1,
            md5ext: `${spriteId}.svg`,
            dataFormat: 'svg',
            rotationCenterX: 32,
            rotationCenterY: 32,
          },
        ],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
      },
    ],
    monitors: [
      {
        id: FixtureScoreId,
        mode: 'default',
        opcode: 'data_variable',
        params: { VARIABLE: 'score' },
        spriteName: null,
        value: 0,
        width: 0,
        height: 0,
        x: 10,
        y: 10,
        visible: true,
        sliderMin: 0,
        sliderMax: 100,
        isDiscrete: true,
      },
    ],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'Tro authored evaluation fixture' },
  });
  return zipSync(
    {
      'project.json': strToU8(JSON.stringify(project)),
      [`${backdropId}.svg`]: strToU8(backdrop),
      [`${spriteId}.svg`]: strToU8(sprite),
    },
    { level: 6, mtime: new Date('2020-01-01T00:00:00Z') },
  );
}

/** Creates an ordinary starting project for one supported score bug. */
export function createScratchProjectArchive(
  bug: ScratchFixtureBug = ScratchFixtureBug.RESET_INSIDE_LOOP,
): Uint8Array {
  return createAuthoredScratchProjectArchive(z.enum(ScratchFixtureBug).parse(bug));
}

/** Evaluator-only calibration control; never imported into a candidate workspace. */
export function createRepairedScratchProjectArchive(): Uint8Array {
  return createAuthoredScratchProjectArchive(null);
}

/** Parse only project.json. Asset bodies are not inflated, filenames are never
 * written to disk, and ZIP metadata is bounded before decompression. */
export function parseScratchProjectArchive(bytes: Uint8Array): ScratchProject {
  if (bytes.byteLength > ScratchProjectLimits.ARCHIVE_BYTES) {
    throw new Error('scratch_archive_too_large');
  }
  let entries = 0;
  let projectEntries = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (entry) => {
        entries += 1;
        if (
          entries > ScratchProjectLimits.ARCHIVE_ENTRIES ||
          entry.name.includes('/') ||
          entry.name.includes('\\') ||
          entry.name.includes('\0') ||
          entry.name === '..'
        ) {
          throw new Error('scratch_archive_entry_limit');
        }
        if (entry.name !== 'project.json') {
          return false;
        }
        projectEntries += 1;
        if (
          projectEntries !== 1 ||
          !Number.isInteger(entry.originalSize) ||
          entry.originalSize < 0 ||
          entry.originalSize > ScratchProjectLimits.PROJECT_BYTES
        ) {
          throw new Error('scratch_project_entry_invalid');
        }
        return true;
      },
    });
  } catch {
    throw new Error('scratch_archive_invalid');
  }
  const projectBytes = files['project.json'];
  if (!projectBytes || projectBytes.byteLength > ScratchProjectLimits.PROJECT_BYTES) {
    throw new Error('scratch_project_missing_or_too_large');
  }
  try {
    const raw: unknown = JSON.parse(strFromU8(projectBytes));
    return ScratchProjectSchema.parse(raw);
  } catch {
    throw new Error('scratch_project_invalid');
  }
}

function findScoreVariable(
  project: ScratchProject,
): { id: string; value: z.infer<typeof ScalarSchema> } | null {
  const stage = project.targets.find((target) => target.isStage);
  if (!stage) {
    return null;
  }
  const matches = Object.entries(stage.variables).filter(([, variable]) => variable[0] === 'score');
  const match = matches.length === 1 ? matches[0] : undefined;
  return match ? { id: match[0], value: match[1][1] } : null;
}

function readNumber(value: z.infer<typeof ScalarSchema> | undefined): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= ScratchProjectLimits.VALUE ? number : null;
}

/** Exported variable contents are state evidence, not proof that a green-flag run
 * happened. The live adapter records that separate UI/input observation. */
export function readScratchScore(project: ScratchProject): number | null {
  return readNumber(findScoreVariable(project)?.value);
}

class UnsupportedScratchProgram extends Error {}

const ExpressionKind = { NUMBER: 'number', VARIABLE: 'variable' } as const;
type Expression =
  | { kind: typeof ExpressionKind.NUMBER; value: number }
  | { kind: typeof ExpressionKind.VARIABLE; id: string };
type Instruction =
  | {
      opcode: typeof ScratchOpcode.SET_VARIABLE | typeof ScratchOpcode.CHANGE_VARIABLE;
      id: string;
      value: Expression;
    }
  | { opcode: typeof ScratchOpcode.REPEAT; count: Expression; body: Instruction[]; outer: boolean };

interface CompileContext {
  target: ScratchTarget;
  variableIds: Set<string>;
  visited: Set<string>;
  repeats: number;
}

function readBlock(context: CompileContext, id: string, parent: string | null): ScratchBlock {
  const block = context.target.blocks[id];
  if (!block || Array.isArray(block)) {
    throw new UnsupportedScratchProgram('missing_or_compact_statement');
  }
  if (context.visited.has(id)) {
    throw new UnsupportedScratchProgram('cyclic_or_shared_block');
  }
  if (block.parent !== parent || block.topLevel !== (parent === null)) {
    throw new UnsupportedScratchProgram('invalid_parent_relationship');
  }
  context.visited.add(id);
  return block;
}

function readExpression(
  context: CompileContext,
  input: ScratchInputValue | undefined,
  parent: string,
): Expression {
  if (Array.isArray(input)) {
    if (input[0] === 12) {
      const id = input[2];
      if (typeof id !== 'string' || !context.variableIds.has(id)) {
        throw new UnsupportedScratchProgram('missing_variable_reference');
      }
      return { kind: ExpressionKind.VARIABLE, id };
    }
    if (![4, 5, 6, 7, 8, 10].includes(input[0])) {
      throw new UnsupportedScratchProgram('unsupported_primitive');
    }
    const value = readNumber(input[1]);
    if (value === null) {
      throw new UnsupportedScratchProgram('non_numeric_expression');
    }
    return { kind: ExpressionKind.NUMBER, value };
  }
  if (typeof input !== 'string') {
    throw new UnsupportedScratchProgram('missing_numeric_input');
  }
  const block = readBlock(context, input, parent);
  if (!NumberOpcodes.has(block.opcode) || block.next !== null) {
    throw new UnsupportedScratchProgram('unsupported_expression');
  }
  const value = readNumber(block.fields['NUM']?.[0]);
  if (value === null) {
    throw new UnsupportedScratchProgram('non_numeric_expression');
  }
  return { kind: ExpressionKind.NUMBER, value };
}

function compileSequence(
  context: CompileContext,
  start: string | null,
  parent: string,
  nested: boolean,
): Instruction[] {
  const instructions: Instruction[] = [];
  let id = start;
  let expectedParent = parent;
  while (id !== null) {
    const block = readBlock(context, id, expectedParent);
    if (block.opcode === ScratchOpcode.REPEAT) {
      if (!nested) {
        context.repeats += 1;
      }
      const substack = block.inputs['SUBSTACK']?.[1];
      if (substack !== null && typeof substack !== 'string') {
        throw new UnsupportedScratchProgram('invalid_repeat_body');
      }
      instructions.push({
        opcode: ScratchOpcode.REPEAT,
        count: readExpression(context, block.inputs['TIMES']?.[1], id),
        body: compileSequence(context, substack, id, true),
        outer: !nested,
      });
    } else if (
      block.opcode === ScratchOpcode.SET_VARIABLE ||
      block.opcode === ScratchOpcode.CHANGE_VARIABLE
    ) {
      const variableId = block.fields['VARIABLE']?.[1];
      if (typeof variableId !== 'string' || !context.variableIds.has(variableId)) {
        throw new UnsupportedScratchProgram('missing_variable_reference');
      }
      instructions.push({
        opcode: block.opcode,
        id: variableId,
        value: readExpression(context, block.inputs['VALUE']?.[1], id),
      });
    } else {
      throw new UnsupportedScratchProgram('unsupported_opcode');
    }
    expectedParent = id;
    id = block.next;
  }
  return instructions;
}

function evaluateExpression(expression: Expression, variables: Map<string, number>): number {
  const value =
    expression.kind === ExpressionKind.NUMBER ? expression.value : variables.get(expression.id);
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    Math.abs(value) > ScratchProjectLimits.VALUE
  ) {
    throw new UnsupportedScratchProgram('invalid_runtime_value');
  }
  return value;
}

function runInstructions(
  instructions: Instruction[],
  variables: Map<string, number>,
  turns: number,
  budget: { steps: number },
): void {
  for (const instruction of instructions) {
    budget.steps += 1;
    if (budget.steps > ScratchProjectLimits.STEPS) {
      throw new UnsupportedScratchProgram('evaluation_step_limit');
    }
    if (instruction.opcode === ScratchOpcode.REPEAT) {
      const count = instruction.outer
        ? turns
        : Math.max(0, Math.round(evaluateExpression(instruction.count, variables)));
      if (count > ScratchProjectLimits.REPEAT) {
        throw new UnsupportedScratchProgram('evaluation_repeat_limit');
      }
      for (let iteration = 0; iteration < count; iteration += 1) {
        runInstructions(instruction.body, variables, turns, budget);
      }
    } else {
      const value = evaluateExpression(instruction.value, variables);
      const previous = variables.get(instruction.id) ?? 0;
      const nextValue =
        instruction.opcode === ScratchOpcode.SET_VARIABLE ? value : previous + value;
      if (!Number.isFinite(nextValue) || Math.abs(nextValue) > ScratchProjectLimits.VALUE) {
        throw new UnsupportedScratchProgram('invalid_runtime_value');
      }
      variables.set(instruction.id, nextValue);
    }
  }
}

export interface ScratchProjectGrade {
  supported: boolean;
  passed: boolean;
  reasons: string[];
}

/** Grade the actual exported graph, never the agent's success text. This bounded
 * interpreter covers this authored score exercise, not arbitrary Scratch. Unknown
 * operations/invalid graphs remain unsupported so callers can report unassessed. */
export function gradeScratchProject(project: ScratchProject): ScratchProjectGrade {
  const score = findScoreVariable(project);
  if (!score) {
    return { supported: true, passed: false, reasons: ['missing_or_ambiguous_global_score'] };
  }
  const hats = project.targets.flatMap((target) =>
    Object.entries(target.blocks).flatMap(([id, block]) =>
      !Array.isArray(block) && block.opcode === ScratchOpcode.GREEN_FLAG
        ? [{ id, block, target }]
        : [],
    ),
  );
  const hat = hats.length === 1 ? hats[0] : undefined;
  if (!hat) {
    return {
      supported: hats.length === 0,
      passed: false,
      reasons: [hats.length === 0 ? 'missing_green_flag_script' : 'multiple_green_flag_scripts'],
    };
  }
  try {
    const stage = project.targets.find((target) => target.isStage);
    const variableEntries = [
      ...Object.entries(stage?.variables ?? {}),
      ...Object.entries(hat.target.variables),
    ];
    const initial = new Map<string, number>();
    for (const [id, variable] of variableEntries) {
      const value = readNumber(variable[1]);
      if (value === null) {
        throw new UnsupportedScratchProgram('non_numeric_variable');
      }
      initial.set(id, value);
    }
    const context: CompileContext = {
      target: hat.target,
      variableIds: new Set(initial.keys()),
      visited: new Set(),
      repeats: 0,
    };
    const hatBlock = readBlock(context, hat.id, null);
    const instructions = compileSequence(context, hatBlock.next, hat.id, false);
    if (context.repeats !== 1) {
      throw new UnsupportedScratchProgram('missing_or_ambiguous_turn_loop');
    }
    const outerRepeat = instructions.find(
      (instruction) => instruction.opcode === ScratchOpcode.REPEAT,
    );
    if (outerRepeat?.count.kind === ExpressionKind.VARIABLE) {
      throw new UnsupportedScratchProgram('dynamic_turn_loop_count');
    }
    if (!outerRepeat || evaluateExpression(outerRepeat.count, initial) !== 3) {
      return { supported: true, passed: false, reasons: ['repeat_count_is_not_three'] };
    }
    const reasons: string[] = [];
    for (const turns of [0, 1, 3, 5]) {
      for (const initialScore of [0, 7]) {
        const variables = new Map(initial);
        variables.set(score.id, initialScore);
        runInstructions(instructions, variables, turns, { steps: 0 });
        if (variables.get(score.id) !== turns) {
          reasons.push(`score_behavior_mismatch:${String(turns)}:initial_${String(initialScore)}`);
        }
      }
    }
    return { supported: true, passed: reasons.length === 0, reasons };
  } catch (error) {
    return {
      supported: false,
      passed: false,
      reasons: [
        error instanceof UnsupportedScratchProgram ? error.message : 'scratch_grade_unavailable',
      ],
    };
  }
}
