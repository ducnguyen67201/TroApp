import { dialog } from 'electron';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { SignedInEvaluationApplication } from './RunSignedInEvaluation.js';

export const EvaluationScenarioSelectionLimits = {
  FILE_BYTES: 1024 * 1024,
} as const;

export const EvaluationScenarioSelectionFailure = {
  SELECTION_FAILED: 'evaluation_scenario_selection_failed',
  HEADER_INVALID: 'evaluation_scenario_header_invalid',
  FILE_TOO_LARGE: 'evaluation_scenario_file_too_large',
} as const;

export interface EvaluationScenarioSelection {
  application: SignedInEvaluationApplication;
  scenarioFile: string;
}

export interface EvaluationScenarioSelectionPorts {
  chooseFile(): Promise<string | null>;
}

/* Development main needs only the application discriminator to select its fixed
 * launcher. The internal evaluator owns complete manifest validation. */
const ScenarioHeaderSchema = z.object({ application: z.enum(SignedInEvaluationApplication) });

async function chooseScenarioFile(): Promise<string | null> {
  const selection = await dialog.showOpenDialog({
    title: 'Choose an internal evaluation scenario',
    properties: ['openFile'],
    filters: [{ name: 'Evaluation scenario', extensions: ['json'] }],
  });
  return selection.canceled || selection.filePaths.length !== 1
    ? null
    : (selection.filePaths[0] ?? null);
}

async function readScenarioApplication(path: string): Promise<SignedInEvaluationApplication> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile()) {
        throw new Error(EvaluationScenarioSelectionFailure.HEADER_INVALID);
      }
      if (before.size > EvaluationScenarioSelectionLimits.FILE_BYTES) {
        throw new Error(EvaluationScenarioSelectionFailure.FILE_TOO_LARGE);
      }
      const buffer = Buffer.alloc(EvaluationScenarioSelectionLimits.FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > EvaluationScenarioSelectionLimits.FILE_BYTES) {
        throw new Error(EvaluationScenarioSelectionFailure.FILE_TOO_LARGE);
      }
      const after = await file.stat();
      const current = await lstat(path);
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== bytesRead ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        !current.isFile() ||
        current.ino !== after.ino ||
        current.dev !== after.dev ||
        current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs
      ) {
        throw new Error(EvaluationScenarioSelectionFailure.HEADER_INVALID);
      }
      const source = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      );
      const input: unknown = JSON.parse(source);
      return ScenarioHeaderSchema.parse(input).application;
    } finally {
      await file.close();
    }
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message === EvaluationScenarioSelectionFailure.FILE_TOO_LARGE
    ) {
      throw new Error(EvaluationScenarioSelectionFailure.FILE_TOO_LARGE, { cause: error });
    }
    throw new Error(EvaluationScenarioSelectionFailure.HEADER_INVALID, { cause: error });
  }
}

/** Internal development menu selection. Only a native user-selected bounded
 * regular file is read; this adds no renderer filesystem or command capability.
 * Paths, file contents and raw filesystem errors are never logged. */
export async function selectEvaluationScenario(
  ports: EvaluationScenarioSelectionPorts = { chooseFile: chooseScenarioFile },
): Promise<EvaluationScenarioSelection | null> {
  let path: string | null;
  try {
    path = await ports.chooseFile();
  } catch {
    throw new Error(EvaluationScenarioSelectionFailure.SELECTION_FAILED);
  }
  if (path === null) {
    return null;
  }
  if (!isAbsolute(path)) {
    throw new Error(EvaluationScenarioSelectionFailure.HEADER_INVALID);
  }
  return { application: await readScenarioApplication(path), scenarioFile: path };
}
