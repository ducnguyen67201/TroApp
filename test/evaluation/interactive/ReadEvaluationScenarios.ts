import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { z } from 'zod';
import {
  EvaluationScenarioCollectionSchema,
  EvaluationScenarioLimits,
  EvaluationScenarioSchema,
  type EvaluationScenario,
} from './EvaluationScenario.js';

async function readBoundedScenarioJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > EvaluationScenarioLimits.INPUT_BYTES) {
      throw new Error('scenario_input_unavailable_or_too_large');
    }
    const buffer = Buffer.alloc(EvaluationScenarioLimits.INPUT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    const current = await lstat(path);
    if (
      bytesRead > EvaluationScenarioLimits.INPUT_BYTES ||
      !current.isFile() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.ino !== after.ino ||
      current.dev !== after.dev ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('scenario_input_changed_or_too_large');
    }
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
    );
    return value;
  } finally {
    await file.close();
  }
}

export async function readEvaluationScenarioFile(path: string): Promise<EvaluationScenario> {
  return EvaluationScenarioSchema.parse(await readBoundedScenarioJson(path));
}

export async function readEvaluationScenarioCollectionFile(
  path: string,
): Promise<EvaluationScenario[]> {
  return EvaluationScenarioCollectionSchema.parse(await readBoundedScenarioJson(path));
}

/** Validation tooling keeps individual entries unknown so a malformed case gets
 * a bounded failure record rather than being mistaken for an absent case. */
export async function readEvaluationScenarioInputsFile(path: string): Promise<unknown[]> {
  return z
    .array(z.unknown())
    .min(1)
    .max(EvaluationScenarioLimits.SCENARIOS)
    .parse(await readBoundedScenarioJson(path));
}
