import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OnboardingProgressSchema, type OnboardingProgress } from '#contracts/Onboarding.js';
import { createOnboardingProgress } from '../../onboarding/domain/OnboardingProgress.js';
import type { OnboardingStore } from '../../onboarding/application/OnboardingStore.js';

/** Owns private atomic files. Account identifiers never become paths; failed reads preserve originals. */
export class OnboardingPreferences implements OnboardingStore {
  constructor(private readonly directory: string) {}

  async readProgress(accountId: string): Promise<OnboardingProgress> {
    try {
      const contents = await readFile(this.resolveFile(accountId), 'utf8');
      const value: unknown = JSON.parse(contents);
      return OnboardingProgressSchema.parse(value);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return createOnboardingProgress();
      }
      console.warn('onboarding.preferences.failed', { stage: 'read' });
      throw new Error('Onboarding progress could not be read.', { cause: error });
    }
  }

  async saveProgress(accountId: string, progress: OnboardingProgress): Promise<void> {
    const validated = OnboardingProgressSchema.parse(progress);
    const file = this.resolveFile(accountId);
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryFile, JSON.stringify(validated), { mode: 0o600, flag: 'wx' });
      await rename(temporaryFile, file);
    } catch {
      console.warn('onboarding.preferences.failed', { stage: 'save' });
      throw new Error('Onboarding progress could not be saved.');
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  private resolveFile(accountId: string): string {
    return join(this.directory, `${createHash('sha256').update(accountId).digest('hex')}.json`);
  }
}
