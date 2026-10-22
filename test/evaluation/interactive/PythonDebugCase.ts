/** An authored replay of the visible classroom activity, not a verbatim request.
 * The source video contains identifiable students, so only provenance and the
 * reconstructed exercise belong in this portable evaluation case. */
export const PythonDebugCase = {
  id: 'DebugPython',
  request:
    'Em đang viết trò chơi đoán số bằng Python. Khi em nhập số lớn hơn số bí mật thì không có thông báo. Giúp em tìm lỗi và hướng dẫn em sửa từng bước, rồi lưu để em chạy lại nhé.',
  historyText:
    'Em đang học câu lệnh điều kiện và vòng lặp trong VS Code. Em đã viết phần nhập số, thông báo đoán đúng và thông báo số đoán nhỏ hơn số bí mật.',
  startingSource: [
    'so_bi_mat = 77',
    'while True:',
    '    doan = int(input("Nhập số bạn đoán: "))',
    '    if doan == so_bi_mat:',
    '        print("Chúc mừng bạn đã đoán đúng!")',
    '        break',
    '    elif doan < so_bi_mat:',
    '        print("Số bạn đoán nhỏ hơn số bí mật")',
    '        ',
  ].join('\n'),
  startingCursor: { line: 9, column: 9 },
  provenance: {
    kind: 'customer_video_reconstruction',
    suppliedOn: '2026-10-21',
    recordingDate: null,
    sourceId: 'CustomerPythonVideo20261021',
    observedEditor: 'Visual Studio Code',
    observedStartingFrameSeconds: 18,
    requestOrigin: 'authored_paraphrase',
    originalRequestCaptured: false,
    observedGuidance: 'Dedent line 9 once, align else with if/elif, then enter its print body.',
  },
} as const;

export const PythonDebugLimits = {
  SOURCE_BYTES: 16 * 1024,
  LINES: 128,
  TOKENS: 2048,
  DEPTH: 6,
  STEPS: 1024,
  OUTPUTS: 64,
} as const;

export const PythonDebugMilestoneId = {
  BRANCH_ALIGNMENT: 'branch_alignment',
  GREATER_FEEDBACK: 'greater_feedback',
  PROGRAM_PRESERVED: 'program_preserved',
  GENERAL_BEHAVIOR: 'general_behavior',
} as const;

export const PythonDebugMilestoneStatus = {
  PASS: 'pass',
  FAIL: 'fail',
  UNASSESSED: 'unassessed',
} as const;

export interface PythonDebugMilestone {
  id: (typeof PythonDebugMilestoneId)[keyof typeof PythonDebugMilestoneId];
  title: string;
  status: (typeof PythonDebugMilestoneStatus)[keyof typeof PythonDebugMilestoneStatus];
  passed: boolean | null;
}

export interface PythonDebugGrade {
  supported: boolean;
  passed: boolean;
  reasons: string[];
  milestones: PythonDebugMilestone[];
}

const TokenKind = { NAME: 'name', NUMBER: 'number', STRING: 'string', SYMBOL: 'symbol' } as const;
type Token = { kind: (typeof TokenKind)[keyof typeof TokenKind]; value: string };
type SourceLine = { indent: number; tokens: Token[] };
const ExpressionKind = { NUMBER: 'number', STRING: 'string', VARIABLE: 'variable' } as const;
type Expression =
  | { kind: typeof ExpressionKind.NUMBER; value: number }
  | { kind: typeof ExpressionKind.STRING; value: string }
  | { kind: typeof ExpressionKind.VARIABLE; name: string };
const NodeKind = {
  ASSIGN: 'assign',
  INPUT: 'input',
  WHILE: 'while',
  IF: 'if',
  PRINT: 'print',
  BREAK: 'break',
  PASS: 'pass',
} as const;
type Comparison = { left: Expression; operator: string; right: Expression };
type Statement =
  | { kind: typeof NodeKind.ASSIGN; name: string; value: Expression }
  | { kind: typeof NodeKind.INPUT; name: string }
  | { kind: typeof NodeKind.WHILE; body: Statement[] }
  | {
      kind: typeof NodeKind.IF;
      branches: { condition: Comparison; body: Statement[] }[];
      otherwise: Statement[] | null;
    }
  | { kind: typeof NodeKind.PRINT; values: Expression[] }
  | { kind: typeof NodeKind.BREAK | typeof NodeKind.PASS };

class UnsupportedPython extends Error {}
class InvalidPython extends Error {}
class InputExhausted extends Error {}

const ReservedPythonNames = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

function tokenizeLine(text: string, tokenBudget: { count: number }): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < text.length) {
    const character = text[offset];
    if (character === undefined || character === '#') {
      break;
    }
    if (character === ' ') {
      offset += 1;
      continue;
    }
    let token: Token;
    if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      let closed = false;
      offset += 1;
      while (offset < text.length) {
        const next = text[offset];
        offset += 1;
        if (next === quote) {
          closed = true;
          break;
        }
        if (next === '\\') {
          const escaped = text[offset];
          offset += 1;
          if (escaped !== '\\' && escaped !== '"' && escaped !== "'" && escaped !== 'n') {
            throw new UnsupportedPython('unsupported_string_escape');
          }
          value += escaped === 'n' ? '\n' : escaped;
        } else if (next !== undefined) {
          value += next;
        }
      }
      if (!closed) {
        throw new InvalidPython('unterminated_string');
      }
      token = { kind: TokenKind.STRING, value };
    } else {
      const rest = text.slice(offset);
      const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest)?.[0];
      const number = /^-?\d+/.exec(rest)?.[0];
      const symbol = /^(==|!=|<=|>=|[=<>():,])/.exec(rest)?.[0];
      if (name) {
        const next = rest[name.length];
        if (/^(?:f|r|b|u|fr|rf|br|rb)$/i.test(name) && (next === '"' || next === "'")) {
          throw new UnsupportedPython('unsupported_string_prefix');
        }
        token = { kind: TokenKind.NAME, value: name };
      } else if (number) {
        token = { kind: TokenKind.NUMBER, value: number };
      } else if (symbol) {
        token = { kind: TokenKind.SYMBOL, value: symbol };
      } else {
        throw new UnsupportedPython('unsupported_python_token');
      }
      offset += token.value.length;
    }
    tokens.push(token);
    tokenBudget.count += 1;
    if (tokenBudget.count > PythonDebugLimits.TOKENS) {
      throw new UnsupportedPython('python_token_limit');
    }
  }
  return tokens;
}

function readSourceLines(source: string): SourceLine[] {
  if (new TextEncoder().encode(source).byteLength > PythonDebugLimits.SOURCE_BYTES) {
    throw new UnsupportedPython('python_source_limit');
  }
  const normalized = source.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  if (
    lines.length > PythonDebugLimits.LINES ||
    normalized.includes('\t') ||
    normalized.includes('\r')
  ) {
    throw new UnsupportedPython('unsupported_line_layout');
  }
  const budget = { count: 0 };
  return lines.flatMap((line) => {
    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).replaceAll(' ', '') !== '') {
      throw new UnsupportedPython('unsupported_indentation_character');
    }
    const tokens = tokenizeLine(line.slice(indent), budget);
    if (tokens.length === 0) {
      return [];
    }
    if (indent % 4 !== 0) {
      throw new UnsupportedPython('unsupported_indentation_width');
    }
    return [{ indent, tokens }];
  });
}

class LineReader {
  private offset = 0;

  constructor(private readonly tokens: Token[]) {}

  matches(value: string): boolean {
    const token = this.peek();
    const expectedKind = /^[A-Za-z_]/.test(value) ? TokenKind.NAME : TokenKind.SYMBOL;
    return token?.kind === expectedKind && token.value === value;
  }

  readValue(value: string): void {
    if (!this.matches(value)) {
      throw new InvalidPython('python_statement_invalid');
    }
    this.take();
  }

  take(): Token | undefined {
    const token = this.tokens[this.offset];
    this.offset += 1;
    return token;
  }

  peek(): Token | undefined {
    return this.tokens[this.offset];
  }

  finish(): void {
    if (this.offset !== this.tokens.length) {
      throw new UnsupportedPython('unsupported_statement_suffix');
    }
  }

  readExpression(): Expression {
    const token = this.take();
    if (!token) {
      throw new InvalidPython('python_expression_missing');
    }
    if (token.kind === TokenKind.STRING) {
      return { kind: ExpressionKind.STRING, value: token.value };
    }
    if (token.kind === TokenKind.NUMBER) {
      if (/^-?0\d+/.test(token.value) && Number(token.value) !== 0) {
        throw new InvalidPython('python_integer_invalid');
      }
      const value = Number(token.value);
      if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000) {
        throw new UnsupportedPython('unsupported_number');
      }
      return { kind: ExpressionKind.NUMBER, value };
    }
    if (token.kind === TokenKind.NAME) {
      return { kind: ExpressionKind.VARIABLE, name: token.value };
    }
    throw new UnsupportedPython('unsupported_expression');
  }
}

class ProgramReader {
  private offset = 0;

  constructor(private readonly lines: SourceLine[]) {}

  readProgram(): Statement[] {
    const statements = this.readSuite(0, 0, false);
    if (this.offset !== this.lines.length) {
      throw new InvalidPython('python_indentation_invalid');
    }
    return statements;
  }

  private readSuite(indent: number, depth: number, insideLoop: boolean): Statement[] {
    if (depth > PythonDebugLimits.DEPTH) {
      throw new UnsupportedPython('python_depth_limit');
    }
    const statements: Statement[] = [];
    while (this.offset < this.lines.length) {
      const line = this.lines[this.offset];
      if (!line || line.indent < indent) {
        break;
      }
      if (line.indent > indent) {
        const first = line.tokens[0];
        if (first?.kind === TokenKind.NAME && (first.value === 'elif' || first.value === 'else')) {
          throw new InvalidPython('python_indentation_invalid');
        }
        throw new UnsupportedPython('unsupported_indentation_width');
      }
      const firstToken = line.tokens[0];
      if (
        firstToken?.kind === TokenKind.NAME &&
        (firstToken.value === 'elif' || firstToken.value === 'else')
      ) {
        break;
      }
      this.offset += 1;
      const reader = new LineReader(line.tokens);
      const first = reader.take();
      if (!first || first.kind !== TokenKind.NAME) {
        throw new UnsupportedPython('unsupported_statement');
      }
      if (first.value === 'while') {
        reader.readValue('True');
        reader.readValue(':');
        reader.finish();
        statements.push({ kind: NodeKind.WHILE, body: this.readBody(indent, depth, true) });
      } else if (first.value === 'if') {
        statements.push(this.readConditional(reader, indent, depth, insideLoop));
      } else if (first.value === 'print') {
        reader.readValue('(');
        const values: Expression[] = [];
        while (!reader.matches(')')) {
          values.push(reader.readExpression());
          if (!reader.matches(',')) {
            break;
          }
          reader.readValue(',');
        }
        reader.readValue(')');
        reader.finish();
        statements.push({ kind: NodeKind.PRINT, values });
      } else if (first.value === 'break' || first.value === 'pass') {
        reader.finish();
        if (first.value === 'break' && !insideLoop) {
          throw new InvalidPython('break_outside_loop');
        }
        statements.push({ kind: first.value === 'break' ? NodeKind.BREAK : NodeKind.PASS });
      } else {
        if (!reader.matches('=')) {
          throw new UnsupportedPython('unsupported_statement');
        }
        if (ReservedPythonNames.has(first.value)) {
          throw new InvalidPython('python_assignment_name_invalid');
        }
        if (first.value === 'int' || first.value === 'input') {
          throw new UnsupportedPython('unsupported_builtin_shadowing');
        }
        reader.readValue('=');
        if (reader.matches('int')) {
          for (const value of ['int', '(', 'input', '(']) {
            reader.readValue(value);
          }
          if (!reader.matches(')')) {
            const prompt = reader.readExpression();
            if (prompt.kind !== ExpressionKind.STRING) {
              throw new UnsupportedPython('unsupported_input_prompt');
            }
          }
          reader.readValue(')');
          reader.readValue(')');
          reader.finish();
          statements.push({ kind: NodeKind.INPUT, name: first.value });
        } else {
          const value = reader.readExpression();
          reader.finish();
          statements.push({ kind: NodeKind.ASSIGN, name: first.value, value });
        }
      }
    }
    return statements;
  }

  private readBody(indent: number, depth: number, insideLoop: boolean): Statement[] {
    const body = this.readSuite(indent + 4, depth + 1, insideLoop);
    if (body.length === 0) {
      throw new InvalidPython('python_body_missing');
    }
    return body;
  }

  private readCondition(reader: LineReader): Comparison {
    const left = reader.readExpression();
    const operatorToken = reader.take();
    const operator = operatorToken?.value;
    if (
      operatorToken?.kind !== TokenKind.SYMBOL ||
      !operator ||
      !['==', '!=', '<', '>', '<=', '>='].includes(operator)
    ) {
      throw new UnsupportedPython('unsupported_condition');
    }
    const right = reader.readExpression();
    reader.readValue(':');
    reader.finish();
    return { left, operator, right };
  }

  private readConditional(
    reader: LineReader,
    indent: number,
    depth: number,
    insideLoop: boolean,
  ): Statement {
    const branches = [
      { condition: this.readCondition(reader), body: this.readBody(indent, depth, insideLoop) },
    ];
    let otherwise: Statement[] | null = null;
    while (this.offset < this.lines.length) {
      const line = this.lines[this.offset];
      const firstToken = line?.tokens[0];
      const first = firstToken?.value;
      if (
        !line ||
        firstToken?.kind !== TokenKind.NAME ||
        line.indent !== indent ||
        (first !== 'elif' && first !== 'else')
      ) {
        break;
      }
      this.offset += 1;
      const nextReader = new LineReader(line.tokens);
      nextReader.take();
      if (first === 'else') {
        nextReader.readValue(':');
        nextReader.finish();
        otherwise = this.readBody(indent, depth, insideLoop);
        break;
      }
      branches.push({
        condition: this.readCondition(nextReader),
        body: this.readBody(indent, depth, insideLoop),
      });
    }
    return { kind: NodeKind.IF, branches, otherwise };
  }
}

interface ExecutionState {
  variables: Map<string, number | string>;
  inputs: readonly number[];
  consumedInputs: number;
  outputs: string[];
  steps: number;
  secret: number;
  initializedSecret: boolean;
}

function readExpression(expression: Expression, state: ExecutionState): number | string {
  if (expression.kind !== ExpressionKind.VARIABLE) {
    return expression.value;
  }
  const value = state.variables.get(expression.name);
  if (value === undefined) {
    throw new UnsupportedPython('unbound_variable');
  }
  return value;
}

function compareValues(condition: Comparison, state: ExecutionState): boolean {
  const left = readExpression(condition.left, state);
  const right = readExpression(condition.right, state);
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new UnsupportedPython('unsupported_comparison_values');
  }
  switch (condition.operator) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    default:
      throw new UnsupportedPython('unsupported_condition');
  }
}

function executeStatements(statements: readonly Statement[], state: ExecutionState): boolean {
  for (const statement of statements) {
    state.steps += 1;
    if (state.steps > PythonDebugLimits.STEPS) {
      throw new UnsupportedPython('python_step_limit');
    }
    if (statement.kind === NodeKind.ASSIGN) {
      let value = readExpression(statement.value, state);
      if (statement.name === 'so_bi_mat' && !state.initializedSecret) {
        value = state.secret;
        state.initializedSecret = true;
      }
      state.variables.set(statement.name, value);
    } else if (statement.kind === NodeKind.INPUT) {
      const value = state.inputs[state.consumedInputs];
      if (value === undefined) {
        throw new InputExhausted();
      }
      state.consumedInputs += 1;
      state.variables.set(statement.name, value);
    } else if (statement.kind === NodeKind.PRINT) {
      state.outputs.push(
        statement.values.map((value) => String(readExpression(value, state))).join(' '),
      );
      if (state.outputs.length > PythonDebugLimits.OUTPUTS) {
        throw new UnsupportedPython('python_output_limit');
      }
    } else if (statement.kind === NodeKind.WHILE) {
      while (!executeStatements(statement.body, state)) {
        state.steps += 1;
        if (state.steps > PythonDebugLimits.STEPS) {
          throw new UnsupportedPython('python_step_limit');
        }
      }
    } else if (statement.kind === NodeKind.IF) {
      const body =
        statement.branches.find((branch) => compareValues(branch.condition, state))?.body ??
        statement.otherwise;
      if (body && executeStatements(body, state)) {
        return true;
      }
    } else if (statement.kind === NodeKind.BREAK) {
      return true;
    }
  }
  return false;
}

const FeedbackKind = { LOWER: 'lower', GREATER: 'greater', CORRECT: 'correct' } as const;
type FeedbackKind = (typeof FeedbackKind)[keyof typeof FeedbackKind];

function classifyFeedback(output: string): FeedbackKind | null {
  const text = output.toLowerCase().normalize('NFD').replaceAll(/\p{M}/gu, '').replaceAll('đ', 'd');
  if (/\b(?:khong|chua|not|incorrect|wrong)\b/.test(text)) {
    return null;
  }
  const matches = [
    { kind: FeedbackKind.LOWER, matches: /nho hon|qua nho|too low/.test(text) },
    { kind: FeedbackKind.GREATER, matches: /lon hon|qua lon|too high/.test(text) },
    { kind: FeedbackKind.CORRECT, matches: /doan dung|chuc mung|\bcorrect\b/.test(text) },
  ].filter((match) => match.matches);
  return matches.length === 1 ? (matches[0]?.kind ?? null) : null;
}

function runProbe(
  program: readonly Statement[],
  secret: number,
  inputs: readonly number[],
): boolean {
  const state: ExecutionState = {
    variables: new Map(),
    inputs,
    consumedInputs: 0,
    outputs: [],
    steps: 0,
    secret,
    initializedSecret: false,
  };
  try {
    executeStatements(program, state);
  } catch (error: unknown) {
    if (error instanceof InputExhausted) {
      return false;
    }
    throw error;
  }
  const correctIndex = inputs.indexOf(secret);
  const expectedInputs = correctIndex < 0 ? inputs : inputs.slice(0, correctIndex + 1);
  const expected = expectedInputs.map((input) =>
    input === secret
      ? FeedbackKind.CORRECT
      : input < secret
        ? FeedbackKind.LOWER
        : FeedbackKind.GREATER,
  );
  const observed = state.outputs.map(classifyFeedback);
  return (
    correctIndex >= 0 &&
    state.consumedInputs === expectedInputs.length &&
    observed.length === expected.length &&
    observed.every((value, index) => value === expected[index])
  );
}

function flattenStatements(statements: readonly Statement[]): Statement[] {
  return statements.flatMap((statement) => [
    statement,
    ...(statement.kind === NodeKind.WHILE
      ? flattenStatements(statement.body)
      : statement.kind === NodeKind.IF
        ? [
            ...statement.branches.flatMap((branch) => flattenStatements(branch.body)),
            ...flattenStatements(statement.otherwise ?? []),
          ]
        : []),
  ]);
}

function createMilestones(results: readonly (boolean | null)[]): PythonDebugMilestone[] {
  const definitions: { id: PythonDebugMilestone['id']; title: string }[] = [
    {
      id: PythonDebugMilestoneId.BRANCH_ALIGNMENT,
      title: 'The greater-guess branch aligns with the other conditional branches.',
    },
    {
      id: PythonDebugMilestoneId.GREATER_FEEDBACK,
      title: 'A greater guess receives the correct feedback and can continue.',
    },
    {
      id: PythonDebugMilestoneId.PROGRAM_PRESERVED,
      title: 'The original secret, input loop, lower feedback and successful exit remain.',
    },
    {
      id: PythonDebugMilestoneId.GENERAL_BEHAVIOR,
      title: 'Independent boundary, repeated-guess and changed-secret probes pass.',
    },
  ];
  return definitions.map((definition, index) => {
    const passed = results[index] ?? null;
    return {
      ...definition,
      passed,
      status:
        passed === null
          ? PythonDebugMilestoneStatus.UNASSESSED
          : passed
            ? PythonDebugMilestoneStatus.PASS
            : PythonDebugMilestoneStatus.FAIL,
    };
  });
}

/** Parse and interpret only this exercise's bounded Python subset. No supplied
 * source is executed by Python, eval, a shell or a model. Changed-secret probes
 * are counterfactual interpreter checks, not evidence of native editor execution.
 * Unknown syntax is unassessed; known malformed indentation is a failed repair. */
export function gradePythonDebugSource(source: string): PythonDebugGrade {
  try {
    const program = new ProgramReader(readSourceLines(source)).readProgram();
    const all = flattenStatements(program);
    const loop = program.find((statement) => statement.kind === NodeKind.WHILE);
    const conditional = loop?.body.find((statement) => statement.kind === NodeKind.IF);
    const first = program[0];
    const secretPreserved =
      first?.kind === NodeKind.ASSIGN &&
      first.name === 'so_bi_mat' &&
      first.value.kind === ExpressionKind.NUMBER &&
      first.value.value === 77 &&
      all.filter(
        (statement) => statement.kind === NodeKind.ASSIGN && statement.name === 'so_bi_mat',
      ).length === 1;
    const originalInput =
      all.filter((statement) => statement.kind === NodeKind.INPUT && statement.name === 'doan')
        .length === 1;
    const branchAlignment =
      conditional !== undefined &&
      (conditional.otherwise !== null || conditional.branches.length >= 3);
    const greaterFeedback = runProbe(program, 77, [80, 77, 76]);
    const preservedProgram =
      secretPreserved && originalInput && runProbe(program, 77, [70, 77, 80]);
    const generalBehavior = [
      { secret: 77, inputs: [70, 80, 77, 78] },
      { secret: 77, inputs: [76, 78, 77, 70] },
      { secret: 77, inputs: [80, 78, 76, 70, 77] },
      { secret: 42, inputs: [41, 43, 42, 77] },
      { secret: 101, inputs: [102, 100, 101, 77] },
    ].every((probe) => runProbe(program, probe.secret, probe.inputs));
    const results = [branchAlignment, greaterFeedback, preservedProgram, generalBehavior];
    const reasons = [
      ...(!branchAlignment ? ['greater_guess_branch_missing_or_nested'] : []),
      ...(!greaterFeedback ? ['greater_guess_feedback_incorrect'] : []),
      ...(!preservedProgram ? ['original_program_behavior_not_preserved'] : []),
      ...(!generalBehavior ? ['python_behavior_probes_failed'] : []),
    ];
    return {
      supported: true,
      passed: results.every(Boolean),
      reasons,
      milestones: createMilestones(results),
    };
  } catch (error: unknown) {
    const invalid = error instanceof InvalidPython;
    return {
      supported: invalid,
      passed: false,
      reasons: [
        error instanceof UnsupportedPython || error instanceof InvalidPython
          ? error.message
          : 'python_grade_unavailable',
      ],
      milestones: createMilestones(
        invalid ? [false, false, false, false] : [null, null, null, null],
      ),
    };
  }
}
