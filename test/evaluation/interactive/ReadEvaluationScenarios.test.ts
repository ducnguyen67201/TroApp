import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EvaluationScenarioLimits } from './EvaluationScenario.js';
import {
  readEvaluationScenarioCollectionFile,
  readEvaluationScenarioFile,
  readEvaluationScenarioInputsFile,
} from './ReadEvaluationScenarios.js';
import { getDefaultEvaluationScenario } from './ScenarioCatalog.js';

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'TroScenarioRead-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reads a bounded single manifest and a separately validated collection', async () => {
  const directory = await createDirectory();
  const scenario = getDefaultEvaluationScenario('vscode');
  const single = join(directory, 'Scenario.json');
  const collection = join(directory, 'Scenarios.json');
  await writeFile(single, JSON.stringify(scenario));
  await writeFile(collection, JSON.stringify([scenario]));
  expect(await readEvaluationScenarioFile(single)).toEqual(scenario);
  expect(await readEvaluationScenarioCollectionFile(collection)).toEqual([scenario]);
  await expect(readEvaluationScenarioFile(collection)).rejects.toThrow();
  await expect(readEvaluationScenarioCollectionFile(single)).rejects.toThrow();
});

it('keeps malformed entries unknown for the validator while rejecting invalid manifests', async () => {
  const directory = await createDirectory();
  const path = join(directory, 'Scenarios.json');
  await writeFile(path, JSON.stringify([{ unknownField: true }]));
  expect(await readEvaluationScenarioInputsFile(path)).toEqual([{ unknownField: true }]);
  await expect(readEvaluationScenarioCollectionFile(path)).rejects.toThrow();
});

it('rejects oversized, non-UTF8, non-regular and symlink inputs', async () => {
  const directory = await createDirectory();
  const path = join(directory, 'Scenario.json');
  await writeFile(path, Buffer.alloc(EvaluationScenarioLimits.INPUT_BYTES + 1));
  await expect(readEvaluationScenarioFile(path)).rejects.toThrow(
    'scenario_input_unavailable_or_too_large',
  );
  await writeFile(path, Buffer.from([0xff]));
  await expect(readEvaluationScenarioFile(path)).rejects.toThrow();
  await expect(readEvaluationScenarioFile(directory)).rejects.toThrow();
  const link = join(directory, 'Link.json');
  await symlink(path, link);
  await expect(readEvaluationScenarioFile(link)).rejects.toThrow();
});
