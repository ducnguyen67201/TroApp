import { expect, it } from 'vitest';
import { readWindowsDesktopMemory } from '../../scripts/WindowsDesktopMemory.js';

const root = {
  pid: 10,
  parentId: 1,
  startedAt: '100',
  privateCommittedBytes: 100,
  workingSetBytes: 200,
};
const child = { ...root, pid: 20, parentId: 10, startedAt: '101' };

it('totals private commit separately and excludes unrelated processes', () => {
  const rows = [child, root, { ...root, pid: 30 }];
  const result = readWindowsDesktopMemory(JSON.stringify({ before: rows, after: rows }), 10, '100');
  expect(result.privateCommittedBytes).toBe(200);
  expect(result.summedWorkingSetBytes).toBe(400);
  expect(result.processes.map((row) => row.pid)).toEqual([10, 20]);
});

it('rejects root reuse, descendant churn and partial or unsafe counters', () => {
  const rows = [root, child];
  const output = (after: unknown) => JSON.stringify({ before: rows, after });
  expect(() => readWindowsDesktopMemory(output(rows), 10, '99')).toThrow('reused');
  expect(() => readWindowsDesktopMemory(output([root]), 10)).toThrow('changed');
  expect(() =>
    readWindowsDesktopMemory(output([root, { ...child, startedAt: '102' }]), 10),
  ).toThrow('changed');
  for (const privateCommittedBytes of [null, -1, 9007199254740992]) {
    const missing = [{ ...root, privateCommittedBytes }];
    expect(() =>
      readWindowsDesktopMemory(JSON.stringify({ before: missing, after: missing }), 10),
    ).toThrow();
  }
});
