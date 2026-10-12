import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPetWorldLocalState,
  PetWorldLocalStateSchema,
  type PetWorldLocalState,
  type PetWorldLocalStore,
} from './PetWorldLocalState.js';

/** Atomic, account-scoped persistence; unresolved intents survive a desktop restart. */
export class PetWorldPreferences implements PetWorldLocalStore {
  constructor(private readonly directory: string) {}

  async readState(accountId: string): Promise<PetWorldLocalState> {
    try {
      const contents = await readFile(this.resolveFile(accountId), 'utf8');
      if (contents.length > 256_000) {
        throw new Error('Pet world cache exceeds its supported size.');
      }
      const value: unknown = JSON.parse(contents);
      return PetWorldLocalStateSchema.parse(value);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createPetWorldLocalState();
      }
      /* Do not erase a damaged intent file and risk issuing a new duplicate award. */
      console.warn('pet.world.local.failed', { stage: 'read' });
      throw new Error('Pet world local state is unavailable.', { cause: error });
    }
  }

  async saveState(accountId: string, state: PetWorldLocalState): Promise<void> {
    const validated = PetWorldLocalStateSchema.parse(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.resolveFile(accountId);
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, JSON.stringify(validated), { flag: 'wx', mode: 0o600 });
      await rename(temporaryFile, file);
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  private resolveFile(accountId: string): string {
    const accountDigest = createHash('sha256').update(accountId).digest('hex');
    return join(this.directory, `${accountDigest}.json`);
  }
}
