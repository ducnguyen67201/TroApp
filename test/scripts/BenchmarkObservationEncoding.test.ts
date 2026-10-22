import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  benchmarkObservationEncoding,
  parseBenchmarkObservationEncodingOptions,
} from '../../scripts/BenchmarkObservationEncoding.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('accepts bounded local output paths without live-run or positional options', () => {
  expect(parseBenchmarkObservationEncodingOptions([])).toEqual({ output: undefined });
  expect(parseBenchmarkObservationEncodingOptions(['--', '--output', '/synthetic/report'])).toEqual(
    { output: '/synthetic/report' },
  );
  expect(() => parseBenchmarkObservationEncodingOptions(['--live'])).toThrow();
  expect(() => parseBenchmarkObservationEncodingOptions(['unexpected'])).toThrow();
  expect(() => parseBenchmarkObservationEncodingOptions(['--output', '  '])).toThrow();
});

it('writes a fresh readable report and refuses to overwrite an earlier run', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'TroObservationEncodingCommand-'));
  directories.push(parent);
  const output = join(parent, 'Run');
  const { directory, report } = await benchmarkObservationEncoding({ output });
  expect(directory).toBe(output);
  expect(report.allRoundtripsExact).toBe(true);
  expect(report.noTokenRegressions).toBe(true);
  expect(await readFile(join(directory, 'Report.md'), 'utf8')).toContain(
    'Actual provider/model/gateway/embedding calls: 0',
  );
  const json: unknown = JSON.parse(await readFile(join(directory, 'Report.json'), 'utf8'));
  expect(json).toEqual(report);
  await writeFile(join(directory, 'Preserve.txt'), 'preserve');
  await expect(benchmarkObservationEncoding({ output })).rejects.toThrow();
  expect(await readFile(join(directory, 'Preserve.txt'), 'utf8')).toBe('preserve');
});
