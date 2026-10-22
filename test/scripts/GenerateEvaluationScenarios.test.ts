import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  parseGenerateScenarioOptions,
  runScenarioGeneration,
} from '../../scripts/GenerateEvaluationScenarios.js';
import {
  readEvaluationScenarioCollectionFile,
  readEvaluationScenarioFile,
} from '../evaluation/interactive/ReadEvaluationScenarios.js';

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'TroScenarioGenerate-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('parses bounded generation selections without a provider or live-run option', () => {
  expect(
    parseGenerateScenarioOptions([
      '--seed',
      '42',
      '--count',
      '2',
      '--application',
      'scratch',
      '--output',
      '/synthetic/package',
    ]),
  ).toEqual({
    generation: { seed: 42, count: 2, application: 'scratch' },
    output: '/synthetic/package',
  });
  expect(parseGenerateScenarioOptions([])).toEqual({ generation: {}, output: undefined });
  expect(() => parseGenerateScenarioOptions(['--seed', '1e2'])).toThrow();
  expect(() => parseGenerateScenarioOptions(['--count', '-1'])).toThrow();
  expect(() => parseGenerateScenarioOptions(['--application', 'unknown'])).toThrow();
  expect(() => parseGenerateScenarioOptions(['--live'])).toThrow();
});

it('writes reusable single cases, the collection and readable calibration without hidden repairs', async () => {
  const directory = await createDirectory();
  const output = join(directory, 'NewPackage');
  const result = await runScenarioGeneration({ generation: { seed: 17 }, output });
  expect(result.validation.passed).toBe(true);
  const cases = await readEvaluationScenarioCollectionFile(join(output, 'Scenarios.json'));
  expect(cases).toHaveLength(7);
  for (const scenario of cases) {
    expect(await readEvaluationScenarioFile(join(output, scenario.id, 'Scenario.json'))).toEqual(
      scenario,
    );
  }
  const readable = await readFile(join(output, 'Validation.md'), 'utf8');
  expect(readable).toContain('reference_repair');
  expect(readable).toContain('Result: PASS');
  expect(readable).not.toContain('print(');
  expect(readable).not.toContain('expectedSource');
});

it('never overwrites an existing package directory', async () => {
  const directory = await createDirectory();
  await writeFile(join(directory, 'Existing.txt'), 'preserve');
  await expect(
    runScenarioGeneration({ generation: { count: 1 }, output: directory }),
  ).rejects.toThrow();
  expect(await readFile(join(directory, 'Existing.txt'), 'utf8')).toBe('preserve');
});
