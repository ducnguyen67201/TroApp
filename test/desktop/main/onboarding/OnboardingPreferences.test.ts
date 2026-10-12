import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OnboardingStatus } from '#contracts/OnboardingValues.js';
import { OnboardingPreferences } from '../../../../src/desktop/main/onboarding/OnboardingPreferences.js';
import { createOnboardingProgress } from '../../../../src/desktop/onboarding/domain/OnboardingProgress.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.length = 0;
  vi.restoreAllMocks();
});

it('persists independent account progress atomically without exposing account IDs as paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-onboarding-'));
  directories.push(directory);
  const store = new OnboardingPreferences(directory);
  const progress = {
    ...createOnboardingProgress(),
    status: OnboardingStatus.DISMISSED,
    revision: 1,
  };
  await store.saveProgress('../student@example.test', progress);
  expect(
    await new OnboardingPreferences(directory).readProgress('../student@example.test'),
  ).toEqual(progress);
  expect(await store.readProgress('other')).toEqual(createOnboardingProgress());
  expect(await readdir(directory)).toEqual([
    `${createHash('sha256').update('../student@example.test').digest('hex')}.json`,
  ]);
});

it.each(['{broken', JSON.stringify({ ...createOnboardingProgress(), storageVersion: 2 })])(
  'preserves corrupt or unsupported data and emits only safe diagnostics',
  async (contents) => {
    const directory = await mkdtemp(join(tmpdir(), 'tro-onboarding-invalid-'));
    directories.push(directory);
    const file = join(directory, `${createHash('sha256').update('student').digest('hex')}.json`);
    await writeFile(file, contents);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(new OnboardingPreferences(directory).readProgress('student')).rejects.toThrow(
      'could not be read',
    );
    expect(await readFile(file, 'utf8')).toBe(contents);
    expect(warning).toHaveBeenCalledExactlyOnceWith('onboarding.preferences.failed', {
      stage: 'read',
    });
  },
);
