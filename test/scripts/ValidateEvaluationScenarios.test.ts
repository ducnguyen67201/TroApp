import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  parseValidateScenarioOptions,
  runScenarioValidation,
} from '../../scripts/ValidateEvaluationScenarios.js';
import { generateEvaluationScenarios } from '../evaluation/interactive/GenerateEvaluationScenarios.js';

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'TroScenarioValidate-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('requires a collection input and rejects arbitrary execution flags', () => {
  expect(parseValidateScenarioOptions(['--input', '/synthetic/Scenarios.json'])).toEqual({
    input: '/synthetic/Scenarios.json',
    output: undefined,
  });
  expect(() => parseValidateScenarioOptions([])).toThrow();
  expect(() => parseValidateScenarioOptions(['--input', 'data', '--execute'])).toThrow();
});

it('validates local files and preserves per-case invalid-schema findings', async () => {
  const directory = await createDirectory();
  const input = join(directory, 'Scenarios.json');
  const output = join(directory, 'Report');
  await writeFile(input, JSON.stringify(generateEvaluationScenarios({ seed: 1, count: 2 })));
  const report = await runScenarioValidation({ input, output });
  expect(report.passed).toBe(true);
  expect(await readFile(join(output, 'Validation.md'), 'utf8')).toContain('Result: PASS');
  await writeFile(input, JSON.stringify([{ invalid: true }]));
  const invalid = await runScenarioValidation({ input, output: undefined });
  expect(invalid.passed).toBe(false);
  expect(invalid.scenarios[0]?.checks[0]?.reason).toBe('scenario_schema_invalid');
});
