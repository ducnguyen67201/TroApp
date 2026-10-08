import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readTeachingFlowResult } from '../../scripts/ReadTeachingFlowResult.js';

it('requires validated completion evidence even when the launched process exits successfully', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroTeachingProof-'));
  try {
    await expect(readTeachingFlowResult(directory)).rejects.toThrow();
    await writeFile(join(directory, 'ContractResult.json'), '{"status":"passed"}');
    await expect(readTeachingFlowResult(directory)).rejects.toThrow();
    await writeFile(join(directory, 'ContractResult.json'), '{"status":"passed","native":true}');
    await expect(readTeachingFlowResult(directory)).resolves.toEqual({
      status: 'passed',
      native: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
