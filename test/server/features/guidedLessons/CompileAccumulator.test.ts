import { expect, it } from 'vitest';
import {
  AccumulatorCompileError,
  compileAccumulator,
} from '../../../../src/server/features/guidedLessons/domain/CompileAccumulator.js';
import { hashText } from './LessonFixture.js';

function compile(code: string) {
  return compileAccumulator(
    {
      codeBlockId: 'code',
      traceId: 'trace',
      approvalReceiptId: 'approval',
      variantOfCodeBlockId: null,
      code,
      sourceRefs: [{ passageId: 'passage', startOffset: 0, endOffset: 1 }],
    },
    hashText,
  );
}

it('records each binding, addition, and printed result without mutating earlier states', () => {
  const { trace } = compile(
    'numbers = [3, -2, 0, 3]\ntotal = 0\nfor number in numbers:\n    total = total + number\nprint(total)',
  );
  expect(
    trace.events
      .filter((event) => event.operation === 'add')
      .map((event) => event.after.find((binding) => binding.name === 'total')?.value),
  ).toEqual([3, 1, 1, 4]);
  expect(trace.events.at(-1)?.output).toBe(4);
  expect(
    trace.events
      .find((event) => event.operation === 'add')
      ?.before.find((binding) => binding.name === 'total')?.value,
  ).toBe(0);
  expect(new Set(trace.events.map((event) => event.eventId)).size).toBe(trace.events.length);
});

it('handles an empty list and nonzero initial total', () => {
  const { trace } = compile('total = -7\nfor number in []:\n    total += number\nprint(total)');
  expect(trace.events.map((event) => event.operation)).toEqual(['initialize', 'output']);
  expect(trace.events.at(-1)?.output).toBe(-7);
});

it.each([
  'total = 0\nfor number in [1]:\n    total = total + number\nprint(total)\nimport os',
  'total = 0\nfor number in range(5):\n    total = total + number\nprint(total)',
  'total = 0\nfor number in [1]:\n    total = total * number\nprint(total)',
  'total = 0\nfor number in [1]:\n\ttotal += number\nprint(total)',
  'total = 0\nfor number in [1]:\n    total += number\nprint(__import__("os"))',
  'total = 0\nfor total in [1]:\n    total += total\nprint(total)',
  'return = 0\nfor number in [1]:\n    return += number\nprint(return)',
  'total = 0\nfor await in [1]:\n    total += await\nprint(total)',
])('rejects code outside the bounded grammar', (code) => {
  expect(() => compile(code)).toThrow(AccumulatorCompileError);
});

it('rejects an overflowing result and oversized list before returning a trace', () => {
  expect(() =>
    compile('total = 1000000\nfor number in [1]:\n    total += number\nprint(total)'),
  ).toThrow(AccumulatorCompileError);
  expect(() =>
    compile(
      `total = 0\nfor number in [${Array.from({ length: 13 }, () => 1).join(', ')}]:\n    total += number\nprint(total)`,
    ),
  ).toThrow(AccumulatorCompileError);
});

it('uses stable code identity and preserves exact approved lines', () => {
  const code = 'total = 0\nfor number in [1, 2]:\n    total += number\nprint(total)';
  expect(compile(code)).toEqual(compile(code));
  expect(compile(code).trace.codeDigest).toBe(hashText(code));
  expect(
    compile(code)
      .codeBlock.lines.map((line) => line.text)
      .join('\n'),
  ).toBe(code);
});
