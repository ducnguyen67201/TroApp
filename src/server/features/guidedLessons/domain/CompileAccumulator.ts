import {
  CodeBlockSchema,
  TraceOperation,
  TrustedTraceSchema,
  type CodeBlock,
  type SourceRef,
  type StateBinding,
  type TraceEvent,
  type TrustedTrace,
} from '#contracts/GuidedLessons.js';

export const AccumulatorEngineVersion = 'accumulator-1';

export const AccumulatorFailure = {
  UNSUPPORTED_CODE: 'unsupportedCode',
  LIMIT_EXCEEDED: 'limitExceeded',
} as const;

export type AccumulatorFailure = (typeof AccumulatorFailure)[keyof typeof AccumulatorFailure];

export class AccumulatorCompileError extends Error {
  constructor(
    readonly code: AccumulatorFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AccumulatorCompileError';
  }
}

export interface AccumulatorInput {
  codeBlockId: string;
  traceId: string;
  approvalReceiptId: string;
  variantOfCodeBlockId: string | null;
  code: string;
  sourceRefs: SourceRef[];
}

export interface CompiledAccumulator {
  codeBlock: CodeBlock;
  trace: TrustedTrace;
}

const IdentifierPattern = '[A-Za-z_][A-Za-z0-9_]{0,31}';
const AssignmentPattern = new RegExp(`^(${IdentifierPattern}) = (.+)$`);
const LoopPattern = new RegExp(`^for (${IdentifierPattern}) in (.+):$`);
const ReservedNames = new Set([
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
  'print',
]);

function rejectCode(message: string): never {
  throw new AccumulatorCompileError(AccumulatorFailure.UNSUPPORTED_CODE, message);
}

function readCapture(match: RegExpMatchArray | null, index: number, message: string): string {
  const capture = match?.[index];
  if (capture === undefined) {
    return rejectCode(message);
  }
  return capture;
}

function readInteger(text: string): number {
  if (!/^[+-]?(?:0|[1-9][0-9]*)$/.test(text)) {
    return rejectCode('Only integer literals are supported.');
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1000000) {
    throw new AccumulatorCompileError(
      AccumulatorFailure.LIMIT_EXCEEDED,
      'An integer exceeds the supported range.',
    );
  }
  return value;
}

function readList(text: string): number[] {
  if (!text.startsWith('[') || !text.endsWith(']')) {
    return rejectCode('The loop requires an approved integer list.');
  }
  const entries = text.slice(1, -1).trim();
  if (entries.length === 0) {
    return [];
  }
  const items = entries.split(',').map((entry) => readInteger(entry.trim()));
  if (items.length > 12) {
    throw new AccumulatorCompileError(
      AccumulatorFailure.LIMIT_EXCEEDED,
      'The list exceeds twelve items.',
    );
  }
  return items;
}

function readIdentifier(name: string): string {
  if (ReservedNames.has(name)) {
    return rejectCode('A variable uses a reserved name.');
  }
  return name;
}

function copyBindings(bindings: StateBinding[]): StateBinding[] {
  return bindings.map((binding) => ({
    name: binding.name,
    value: Array.isArray(binding.value) ? [...binding.value] : binding.value,
  }));
}

/** Parse a deliberately small Python grammar. This constructs states directly and never executes supplied code. */
export function compileAccumulator(
  input: AccumulatorInput,
  hashText: (text: string) => string,
): CompiledAccumulator {
  const code = input.code.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const sourceLines = code.split('\n');
  if (sourceLines.length > 20 || sourceLines.some((line) => line.length > 200)) {
    throw new AccumulatorCompileError(
      AccumulatorFailure.LIMIT_EXCEEDED,
      'The code exceeds the supported size.',
    );
  }
  if (sourceLines.some((line) => line.includes('\t') || line.includes('\r'))) {
    return rejectCode('Use spaces and ordinary line endings.');
  }
  const codeBlock = CodeBlockSchema.parse({
    codeBlockId: input.codeBlockId,
    language: 'python',
    approvalReceiptId: input.approvalReceiptId,
    variantOfCodeBlockId: input.variantOfCodeBlockId,
    lines: sourceLines.map((text, index) => ({
      lineId: `line-${hashText(`${input.codeBlockId}:${String(index)}`).slice(0, 40)}`,
      text,
    })),
    sourceRefs: input.sourceRefs,
  });
  const statements = codeBlock.lines.filter((line) => line.text.trim().length > 0);
  if (statements.length !== 4 && statements.length !== 5) {
    return rejectCode(
      'Use one integer initialization, one loop addition, and print, with an optional list assignment.',
    );
  }
  const loopIndex = statements.findIndex((line) => LoopPattern.test(line.text));
  if (loopIndex !== statements.length - 3) {
    return rejectCode('Only one top-level loop with one addition is supported.');
  }
  const loopLine = statements[loopIndex];
  const additionLine = statements[loopIndex + 1];
  const outputLine = statements[loopIndex + 2];
  if (!loopLine || !additionLine || !outputLine) {
    return rejectCode('The loop is incomplete.');
  }
  const loopMatch = loopLine.text.match(LoopPattern);
  const itemName = readIdentifier(readCapture(loopMatch, 1, 'The loop is invalid.'));
  const loopSource = readCapture(loopMatch, 2, 'The loop is invalid.');
  let listName: string | null = null;
  let listValues: number[] | null = null;
  let totalName: string | null = null;
  let initialTotal: number | null = null;
  const initializations: { lineId: string; binding: StateBinding }[] = [];
  for (const statement of statements.slice(0, loopIndex)) {
    const match = statement.text.match(AssignmentPattern);
    const name = readIdentifier(
      readCapture(match, 1, 'Only top-level literal assignments are supported.'),
    );
    const expression = readCapture(match, 2, 'Only literal assignments are supported.');
    if (expression.startsWith('[')) {
      if (listName !== null) {
        return rejectCode('Only one input list is supported.');
      }
      listName = name;
      listValues = readList(expression);
      initializations.push({ lineId: statement.lineId, binding: { name, value: listValues } });
    } else {
      if (totalName !== null) {
        return rejectCode('Only one running total is supported.');
      }
      totalName = name;
      initialTotal = readInteger(expression);
      initializations.push({ lineId: statement.lineId, binding: { name, value: initialTotal } });
    }
  }
  if (
    totalName === null ||
    initialTotal === null ||
    itemName === totalName ||
    itemName === listName ||
    listName === totalName
  ) {
    return rejectCode('The input, loop item, and running total must use distinct variables.');
  }
  const items = listName === null ? readList(loopSource) : listValues;
  if (items === null || (listName !== null && loopSource !== listName)) {
    return rejectCode('The loop must read its approved input list.');
  }
  if (
    additionLine.text !== `    ${totalName} = ${totalName} + ${itemName}` &&
    additionLine.text !== `    ${totalName} += ${itemName}`
  ) {
    return rejectCode(
      'The loop body must add the current item to the running total using four spaces.',
    );
  }
  if (outputLine.text !== `print(${totalName})`) {
    return rejectCode('The program must print the running total once after the loop.');
  }
  let bindings: StateBinding[] = [];
  const events: TraceEvent[] = [];
  const appendEvent = (
    lineId: string,
    operation: TraceEvent['operation'],
    next: StateBinding[],
    output: number | null,
  ): void => {
    events.push({
      eventId: `event-${hashText(`${input.traceId}:${String(events.length)}`).slice(0, 40)}`,
      lineId,
      operation,
      before: copyBindings(bindings),
      after: copyBindings(next),
      output,
    });
    bindings = copyBindings(next);
  };
  for (const initialization of initializations) {
    appendEvent(
      initialization.lineId,
      TraceOperation.INITIALIZE,
      [...bindings, initialization.binding],
      null,
    );
  }
  let total = initialTotal;
  for (const item of items) {
    const withoutItem = bindings.filter((binding) => binding.name !== itemName);
    appendEvent(
      loopLine.lineId,
      TraceOperation.BIND_ITEM,
      [...withoutItem, { name: itemName, value: item }],
      null,
    );
    total += item;
    if (Math.abs(total) > 1000000) {
      throw new AccumulatorCompileError(
        AccumulatorFailure.LIMIT_EXCEEDED,
        'A running total exceeds the supported range.',
      );
    }
    appendEvent(
      additionLine.lineId,
      TraceOperation.ADD,
      bindings.map((binding) =>
        binding.name === totalName ? { name: totalName, value: total } : binding,
      ),
      null,
    );
  }
  appendEvent(outputLine.lineId, TraceOperation.OUTPUT, bindings, total);
  const trace = TrustedTraceSchema.parse({
    traceId: input.traceId,
    codeBlockId: input.codeBlockId,
    engineVersion: AccumulatorEngineVersion,
    codeDigest: hashText(code),
    events,
  });
  return { codeBlock, trace };
}
