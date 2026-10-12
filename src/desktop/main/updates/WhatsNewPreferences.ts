import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AppUpdateVersionSchema } from '#contracts/AppUpdate.js';

export const WhatsNewPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lastRunVersion: AppUpdateVersionSchema,
  lastSeenWhatsNewReleaseId: z.string().min(1).max(128).nullable(),
  pendingReleaseId: z.string().min(1).max(128).nullable(),
});

export type SavedWhatsNewPreferences = z.infer<typeof WhatsNewPreferencesSchema>;

export interface WhatsNewStore {
  readPreferences(): Promise<SavedWhatsNewPreferences | null>;
  savePreferences(preferences: SavedWhatsNewPreferences): Promise<void>;
}

/** Installation-scoped state lives in main's userData directory. Invalid files
 * fail visibly without being overwritten; atomic writes survive an app restart. */
export class WhatsNewPreferences implements WhatsNewStore {
  constructor(private readonly directory: string) {}

  async readPreferences(): Promise<SavedWhatsNewPreferences | null> {
    try {
      const contents = await readFile(join(this.directory, 'WhatsNew.json'), 'utf8');
      const value: unknown = JSON.parse(contents);
      return WhatsNewPreferencesSchema.parse(value);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async savePreferences(preferences: SavedWhatsNewPreferences): Promise<void> {
    const validated = WhatsNewPreferencesSchema.parse(preferences);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, 'WhatsNew.json');
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, JSON.stringify(validated), { mode: 0o600, flag: 'wx' });
      await rename(temporaryFile, file);
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }
}
