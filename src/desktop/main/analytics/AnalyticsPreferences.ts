import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const AnalyticsPreferencesSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  installationId: z.uuid(),
});

export type SavedAnalyticsPreferences = z.infer<typeof AnalyticsPreferencesSchema>;

export interface AnalyticsStore {
  readPreferences(): Promise<SavedAnalyticsPreferences | null>;
  savePreferences(preferences: SavedAnalyticsPreferences): Promise<void>;
}

/** Installation preferences are stored atomically in main; unreadable files are never replaced silently. */
export class AnalyticsPreferences implements AnalyticsStore {
  constructor(private readonly directory: string) {}

  async readPreferences(): Promise<SavedAnalyticsPreferences | null> {
    try {
      const contents = await readFile(join(this.directory, 'Analytics.json'), 'utf8');
      const value: unknown = JSON.parse(contents);
      return AnalyticsPreferencesSchema.parse(value);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async savePreferences(preferences: SavedAnalyticsPreferences): Promise<void> {
    const validated = AnalyticsPreferencesSchema.parse(preferences);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, 'Analytics.json');
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, JSON.stringify(validated), { mode: 0o600, flag: 'wx' });
      await rename(temporaryFile, file);
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }
}
