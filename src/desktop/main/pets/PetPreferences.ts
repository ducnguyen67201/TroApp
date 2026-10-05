import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPetPreferences,
  PetPreferencesSchema,
  type PetPreferences as SavedPetPreferences,
} from '#contracts/Pet.js';
import type { PetStore } from './PetController.js';

/** Account identifiers never become paths. Failed reads leave existing files intact. */
export class PetPreferences implements PetStore {
  constructor(private readonly directory: string) {}

  async readPreferences(accountId: string): Promise<SavedPetPreferences> {
    try {
      const contents = await readFile(this.resolveFile(accountId), 'utf8');
      const value: unknown = JSON.parse(contents);
      return PetPreferencesSchema.parse(value);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        console.warn('pet.preferences.failed', { stage: 'read' });
      }
      return createPetPreferences();
    }
  }

  async savePreferences(accountId: string, preferences: SavedPetPreferences): Promise<void> {
    const validated = PetPreferencesSchema.parse(preferences);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.resolveFile(accountId);
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, JSON.stringify(validated), { mode: 0o600, flag: 'wx' });
      await rename(temporaryFile, file);
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  private resolveFile(accountId: string): string {
    const identifier = createHash('sha256').update(accountId).digest('hex');
    return join(this.directory, `${identifier}.json`);
  }
}
