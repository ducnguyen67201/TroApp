import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  benchmarkQuestionContext,
  parseBenchmarkQuestionContextOptions,
} from '../../scripts/BenchmarkQuestionContext.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('accepts only bounded local benchmark options', () => {
  expect(parseBenchmarkQuestionContextOptions([])).toEqual({ quick: false, output: undefined });
  expect(
    parseBenchmarkQuestionContextOptions(['--quick', '--output', '/synthetic/report']),
  ).toEqual({ quick: true, output: '/synthetic/report' });
  expect(() => parseBenchmarkQuestionContextOptions(['--live'])).toThrow();
  expect(() => parseBenchmarkQuestionContextOptions(['--output', ''])).toThrow();
});

it('refuses to replace an existing result directory before running a benchmark', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroContextBenchmarkCommand-'));
  directories.push(directory);
  await writeFile(join(directory, 'Preserve.txt'), 'preserve');
  await expect(benchmarkQuestionContext({ quick: true, output: directory })).rejects.toThrow();
});
