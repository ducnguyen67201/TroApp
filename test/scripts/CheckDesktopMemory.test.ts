import { expect, it } from 'vitest';
import {
  parseDesktopMemoryOptions,
  readDesktopFootprints,
  readDesktopProcessTree,
} from '../../scripts/CheckDesktopMemory.js';

it('selects every descendant even when grandchildren precede parents, excluding unrelated daemons', () => {
  const rows = readDesktopProcessTree(
    [
      '30 20 Fri Oct 9 23:00:00 2026',
      '99 1 Fri Oct 9 20:00:00 2026',
      '20 10 Fri Oct 9 23:00:00 2026',
      '10 1 Fri Oct 9 22:59:00 2026',
    ].join('\n'),
    10,
  );
  expect(rows.map((row) => row.pid)).toEqual([10, 20, 30]);
  expect(rows[0]?.startedAt).toBe('Fri Oct 9 22:59:00 2026');
});

it('refuses a missing root or malformed process metadata', () => {
  expect(() => readDesktopProcessTree('20 1 Fri Oct 9 23:00:00 2026', 10)).toThrow('exited');
  expect(() => readDesktopProcessTree('10 invalid metadata', 10)).toThrow('unavailable');
});

it('uses exact physical footprints including compressed memory instead of rounded headings or peak counters', () => {
  const output = [
    'Tro [10]: 64-bit    Footprint: 100 B (16384 bytes per page)',
    '    phys_footprint: 120 B',
    '    phys_footprint_peak: 900 B',
    'Tro Helper (Renderer) [20]: 64-bit    Footprint: 200 B (16384 bytes per page)',
    '    phys_footprint: 220 B',
    '    phys_footprint_peak: 800 B',
    'Summary Footprint: 300 B',
  ].join('\n');
  expect(readDesktopFootprints(output, [10, 20])).toEqual([
    { pid: 10, physicalFootprintBytes: 120 },
    { pid: 20, physicalFootprintBytes: 220 },
  ]);
});

it('refuses partial, duplicate or unsafe footprint counters instead of underreporting', () => {
  const output = 'Tro [10]: 64-bit\n    phys_footprint: 120 B';
  expect(() => readDesktopFootprints(output, [10, 20])).toThrow('unavailable');
  expect(() => readDesktopFootprints(`${output}\n    phys_footprint: 130 B`, [10])).toThrow(
    'invalid',
  );
  expect(() =>
    readDesktopFootprints('Tro [10]: 64-bit\n    phys_footprint: 9007199254740992 B', [10]),
  ).toThrow('invalid');
});

it('requires an explicit PID and bounds duration and sampling frequency', () => {
  expect(parseDesktopMemoryOptions(['--pid', '10'])).toEqual({
    pid: 10,
    durationSeconds: 0,
    intervalSeconds: 5,
  });
  expect(
    parseDesktopMemoryOptions([
      '--pid',
      '10',
      '--duration-seconds',
      '60',
      '--interval-seconds',
      '2',
    ]),
  ).toEqual({ pid: 10, durationSeconds: 60, intervalSeconds: 2 });
  for (const args of [
    [],
    ['--pid', '0'],
    ['--pid', '10', '--duration-seconds', '3601'],
    ['--pid', '10', '--interval-seconds', '0'],
    ['--pid', '10', '--unknown'],
  ]) {
    expect(() => parseDesktopMemoryOptions(args)).toThrow('Use --pid');
  }
});
