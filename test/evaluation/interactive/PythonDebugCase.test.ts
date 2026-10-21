import { expect, it } from 'vitest';
import {
  PythonDebugCase,
  PythonDebugLimits,
  PythonDebugMilestoneId,
  PythonDebugMilestoneStatus,
  gradePythonDebugSource,
} from './PythonDebugCase.js';

function createRepair(): string {
  return `${PythonDebugCase.startingSource.trimEnd()}\n    else:\n        print("Số bạn đoán lớn hơn số bí mật")\n`;
}

it('records an anonymized reconstruction and identifies the request as a paraphrase', () => {
  expect(PythonDebugCase.provenance.originalRequestCaptured).toBe(false);
  expect(PythonDebugCase.provenance.requestOrigin).toBe('authored_paraphrase');
  expect(PythonDebugCase.provenance.observedEditor).toBe('Visual Studio Code');
  expect(PythonDebugCase.startingCursor).toEqual({ line: 9, column: 9 });
  expect(PythonDebugCase.startingSource.split('\n').at(-1)).toBe('        ');
  expect(PythonDebugCase.request).not.toContain('else');
  expect(PythonDebugCase.historyText).not.toContain('Shift');
});

it('starts with a supported incomplete program that fails the greater-guess behavior', () => {
  const grade = gradePythonDebugSource(PythonDebugCase.startingSource);
  expect(grade.supported).toBe(true);
  expect(grade.passed).toBe(false);
  expect(grade.reasons).toContain('greater_guess_feedback_incorrect');
  expect(
    grade.milestones.find((milestone) => milestone.id === PythonDebugMilestoneId.PROGRAM_PRESERVED)
      ?.passed,
  ).toBe(true);
});

it('accepts the aligned else repair and preserves lower guesses, successful exit and repeated input', () => {
  const grade = gradePythonDebugSource(createRepair());
  expect(grade).toMatchObject({ supported: true, passed: true, reasons: [] });
  expect(grade.milestones).toHaveLength(4);
  expect(
    grade.milestones.every((milestone) => milestone.status === PythonDebugMilestoneStatus.PASS),
  ).toBe(true);
});

it('accepts equivalent greater elif, quote style, comments and reversed comparisons', () => {
  const repair = createRepair()
    .replace('    else:', '    elif so_bi_mat < doan:')
    .replace('doan == so_bi_mat', 'so_bi_mat == doan')
    .replace('"Số bạn đoán lớn hơn số bí mật"', "'Số bạn đoán lớn hơn số bí mật'")
    .replace('so_bi_mat = 77', 'so_bi_mat=77 # preserve the original exercise');
  expect(gradePythonDebugSource(repair).passed).toBe(true);
  expect(gradePythonDebugSource(repair.replaceAll('\n', '\r\n')).passed).toBe(true);
});

it.each([
  { name: 'nested else', change: (source: string) => source.replace('    else:', '        else:') },
  {
    name: 'unindented else body',
    change: (source: string) =>
      source.replace(
        '        print("Số bạn đoán lớn hơn số bí mật")',
        '    print("Số bạn đoán lớn hơn số bí mật")',
      ),
  },
  { name: 'missing colon', change: (source: string) => source.replace('    else:', '    else') },
  {
    name: 'empty body',
    change: (source: string) =>
      source.replace('        print("Số bạn đoán lớn hơn số bí mật")', ''),
  },
])('fails the known malformed $name repair', ({ change }) => {
  const grade = gradePythonDebugSource(change(createRepair()));
  expect(grade.supported).toBe(true);
  expect(grade.passed).toBe(false);
});

it.each([
  {
    name: 'wrong greater message',
    change: (source: string) =>
      source.replace('Số bạn đoán lớn hơn số bí mật', 'Số bạn đoán nhỏ hơn số bí mật'),
  },
  {
    name: 'deleted lower feedback',
    change: (source: string) =>
      source.replace('        print("Số bạn đoán nhỏ hơn số bí mật")', '        pass'),
  },
  {
    name: 'changed secret',
    change: (source: string) => source.replace('so_bi_mat = 77', 'so_bi_mat = 80'),
  },
  {
    name: 'hardcoded comparison',
    change: (source: string) =>
      source
        .replaceAll('doan == so_bi_mat', 'doan == 77')
        .replaceAll('doan < so_bi_mat', 'doan < 77'),
  },
  {
    name: 'deleted break',
    change: (source: string) => source.replace('        break', '        pass'),
  },
  {
    name: 'break on wrong guess',
    change: (source: string) =>
      source.replace(
        '        print("Số bạn đoán lớn hơn số bí mật")',
        '        print("Số bạn đoán lớn hơn số bí mật")\n        break',
      ),
  },
  {
    name: 'no student input',
    change: (source: string) =>
      source.replace('doan = int(input("Nhập số bạn đoán: "))', 'doan = 77'),
  },
])('rejects the supported $name shortcut or regression', ({ change }) => {
  expect(gradePythonDebugSource(change(createRepair()))).toMatchObject({
    supported: true,
    passed: false,
  });
});

it('does not accept a replacement program that prints an answer without using the student code', () => {
  expect(gradePythonDebugSource('print("Số bạn đoán lớn hơn số bí mật")')).toMatchObject({
    supported: true,
    passed: false,
  });
});

it.each([
  'import os\nos.system("echo unsafe")',
  'exec("print(1)")',
  'so_bi_mat = 77\nwhile True:\n    doan = int(input())\n    print(f"{doan}")',
  'so_bi_mat = 77\nwhile True:\n    doan = int(input())\n    doan = doan + 1',
  '\tprint("unsupported tabs")',
])('leaves unsupported Python unassessed without executing it', (source) => {
  const grade = gradePythonDebugSource(source);
  expect(grade.supported).toBe(false);
  expect(grade.passed).toBe(false);
  expect(
    grade.milestones.every(
      (milestone) =>
        milestone.passed === null && milestone.status === PythonDebugMilestoneStatus.UNASSESSED,
    ),
  ).toBe(true);
});

it('bounds source bytes, lines and interpreter work', () => {
  expect(gradePythonDebugSource('x'.repeat(PythonDebugLimits.SOURCE_BYTES + 1)).supported).toBe(
    false,
  );
  expect(gradePythonDebugSource('\n'.repeat(PythonDebugLimits.LINES + 1)).supported).toBe(false);
  expect(gradePythonDebugSource('so_bi_mat = 77\nwhile True:\n    pass').reasons).toContain(
    'python_step_limit',
  );
});

it('does not treat quoted punctuation as executable Python syntax', () => {
  const invalid = createRepair().replaceAll('print(', 'print "(" ');
  expect(gradePythonDebugSource(invalid).passed).toBe(false);
});

it('does not interpret a quoted else or elif label as a Python branch keyword', () => {
  expect(gradePythonDebugSource(createRepair().replace('    else:', '    "else":')).passed).toBe(
    false,
  );
  expect(
    gradePythonDebugSource(createRepair().replace('    elif doan', '    "elif" doan')).passed,
  ).toBe(false);
});

it.each([
  (source: string) => source.replace('so_bi_mat = 77', 'so_bi_mat = 077'),
  (source: string) => source.replaceAll('    ', '\u00a0\u00a0\u00a0\u00a0'),
  (source: string) => source + '\nNone = 0\n',
  (source: string) => source + '\nTrue = 0\n',
  (source: string) => source.replace('so_bi_mat = 77', 'int = 0\nso_bi_mat = 77'),
])('never accepts Python-invalid tokens or unsupported builtin shadowing', (change) => {
  expect(gradePythonDebugSource(change(createRepair())).passed).toBe(false);
});

it.each(['incorrect', 'không đoán đúng', 'not correct'])(
  'does not count negative %s feedback as a correct-guess explanation',
  (message) => {
    expect(
      gradePythonDebugSource(createRepair().replace('Chúc mừng bạn đã đoán đúng!', message)).passed,
    ).toBe(false);
  },
);

it('leaves valid indentation widths outside the authored subset unassessed', () => {
  const alternative = createRepair().replaceAll('    ', '  ');
  expect(gradePythonDebugSource(alternative)).toMatchObject({ supported: false, passed: false });
});
