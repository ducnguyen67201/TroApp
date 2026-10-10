import { expect, it } from 'vitest';
import { readLessonProcesses } from '../../../../src/server/features/guidedLessons/infrastructure/LessonRenderResources.js';

it('sums only the renderer process and all descendants, even when rows are unordered', () => {
  const rows = '204 203 100\n999 1 900000\n203 202 200\n202 201 300\n201 1 400\n300 999 800000';
  const processes = readLessonProcesses(rows, 201);
  expect(processes.map((item) => item.pid)).toEqual([204, 203, 202, 201]);
  expect(processes.reduce((total, item) => total + item.residentBytes, 0)).toBe(1000 * 1024);
  expect(processes.some((item) => item.pid === 999 || item.pid === 300)).toBe(false);
});

it('ignores headers and malformed numeric rows without returning process arguments', () => {
  const rows =
    'PID PPID RSS\n41 1 500\n42 41 250\n0 41 99\n-1 41 99\n43 41 -1\n44 -1 99\n45.5 41 99\n46 41 NaN\n47 41 Infinity\n48 41\n49 41 secret';
  expect(readLessonProcesses(rows, 41)).toEqual([
    { pid: 41, parentId: 1, residentBytes: 500 * 1024 },
    { pid: 42, parentId: 41, residentBytes: 250 * 1024 },
  ]);
});

it('does not include unrelated renderers or mistake a root parent for an owned child', () => {
  const rows = '10 1 20\n11 10 30\n12 11 40\n20 1 50\n21 20 60';
  expect(readLessonProcesses(rows, 11)).toEqual([
    { pid: 11, parentId: 10, residentBytes: 30 * 1024 },
    { pid: 12, parentId: 11, residentBytes: 40 * 1024 },
  ]);
  expect(readLessonProcesses(rows, 999)).toEqual([]);
  expect(readLessonProcesses('', 999)).toEqual([]);
});
