import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const TeachingFlowResultSchema = z.strictObject({
  status: z.literal('passed'),
  native: z.boolean(),
});

/** Exit status alone is insufficient: a packaged host may never execute the test entry. */
export async function readTeachingFlowResult(
  directory: string,
): Promise<z.infer<typeof TeachingFlowResultSchema>> {
  const result: unknown = JSON.parse(
    await readFile(join(directory, 'ContractResult.json'), 'utf8'),
  );
  return TeachingFlowResultSchema.parse(result);
}
