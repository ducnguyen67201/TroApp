import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { dialog } from 'electron';
import {
  EvaluationScenarioSelectionFailure,
  EvaluationScenarioSelectionLimits,
  selectEvaluationScenario,
  type EvaluationScenarioSelectionPorts,
} from '../../../../src/desktop/main/evaluation/SelectEvaluationScenario.js';
import { SignedInEvaluationApplication } from '../../../../src/desktop/main/evaluation/RunSignedInEvaluation.js';

type OpenDialog = (
  ...arguments_: Parameters<typeof dialog.showOpenDialog>
) => ReturnType<typeof dialog.showOpenDialog>;
const nativeDialog = vi.hoisted(() => ({ showOpenDialog: vi.fn<OpenDialog>() }));

vi.mock('electron', () => ({ dialog: nativeDialog }));

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'TroScenarioSelection-'));
  directories.push(directory);
  return directory;
}

function selectPath(path: string | null): EvaluationScenarioSelectionPorts {
  return {
    chooseFile: vi.fn<EvaluationScenarioSelectionPorts['chooseFile']>().mockResolvedValue(path),
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('returns cancellation without opening an evaluation', async () => {
  expect(await selectEvaluationScenario(selectPath(null))).toBeNull();
});

it('uses a native single-file JSON picker for the internal action', async () => {
  nativeDialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await selectEvaluationScenario()).toBeNull();
  expect(nativeDialog.showOpenDialog).toHaveBeenCalledWith({
    title: 'Choose an internal evaluation scenario',
    properties: ['openFile'],
    filters: [{ name: 'Evaluation scenario', extensions: ['json'] }],
  });
});

it.each(Object.values(SignedInEvaluationApplication))(
  'selects a bounded %s header and leaves full validation to the evaluator',
  async (application) => {
    const directory = await createDirectory();
    const path = join(directory, 'Scenario.json');
    await writeFile(
      path,
      JSON.stringify({
        application,
        unvalidatedScenarioFields: { fixture: 'private authored fixture' },
      }),
    );
    expect(await selectEvaluationScenario(selectPath(path))).toEqual({
      application,
      scenarioFile: path,
    });
  },
);

it.each(['{}', '{"application":"controlled"}', '{"application":12}', 'private malformed JSON'])(
  'rejects an unsupported header without exposing its content',
  async (content) => {
    const directory = await createDirectory();
    const path = join(directory, 'Scenario.json');
    await writeFile(path, content);
    await expect(selectEvaluationScenario(selectPath(path))).rejects.toThrow(
      EvaluationScenarioSelectionFailure.HEADER_INVALID,
    );
  },
);

it('rejects invalid UTF-8, directories, missing files and relative selections', async () => {
  const directory = await createDirectory();
  const invalidEncoding = join(directory, 'Invalid.json');
  await writeFile(invalidEncoding, Buffer.from([0xff, 0xfe, 0x7b]));
  const nestedDirectory = join(directory, 'Nested');
  await mkdir(nestedDirectory);
  for (const path of [
    invalidEncoding,
    nestedDirectory,
    join(directory, 'Missing.json'),
    'Scenario.json',
  ]) {
    await expect(selectEvaluationScenario(selectPath(path))).rejects.toThrow(
      EvaluationScenarioSelectionFailure.HEADER_INVALID,
    );
  }
});

it('rejects symlinks instead of reading their target', async () => {
  const directory = await createDirectory();
  const target = join(directory, 'Target.json');
  const link = join(directory, 'Scenario.json');
  await writeFile(target, JSON.stringify({ application: SignedInEvaluationApplication.VSCODE }));
  await symlink(target, link);
  await expect(selectEvaluationScenario(selectPath(link))).rejects.toThrow(
    EvaluationScenarioSelectionFailure.HEADER_INVALID,
  );
});

it('bounds file size before parsing the manifest', async () => {
  const directory = await createDirectory();
  const path = join(directory, 'Scenario.json');
  await writeFile(path, ' '.repeat(EvaluationScenarioSelectionLimits.FILE_BYTES + 1));
  await expect(selectEvaluationScenario(selectPath(path))).rejects.toThrow(
    EvaluationScenarioSelectionFailure.FILE_TOO_LARGE,
  );
});

it('replaces native chooser errors with a safe failure code', async () => {
  const ports: EvaluationScenarioSelectionPorts = {
    chooseFile: vi
      .fn<EvaluationScenarioSelectionPorts['chooseFile']>()
      .mockRejectedValue(new Error('private native path')),
  };
  await expect(selectEvaluationScenario(ports)).rejects.toThrow(
    EvaluationScenarioSelectionFailure.SELECTION_FAILED,
  );
});
