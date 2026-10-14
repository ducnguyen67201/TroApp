import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsPreferences } from '../../../../src/desktop/main/analytics/AnalyticsPreferences.js';

const directories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tro-analytics-test-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('analytics preference storage', () => {
  it('treats missing files as no consent and persists validated installation settings', async () => {
    const store = new AnalyticsPreferences(await createDirectory());
    expect(await store.readPreferences()).toBeNull();
    const preferences = {
      version: 1 as const,
      enabled: true,
      installationId: 'cd8b39e6-44a7-4c71-ad49-ae50ca2b34ef',
    };
    await store.savePreferences(preferences);
    expect(await store.readPreferences()).toEqual(preferences);
  });

  it('preserves invalid files so reading them cannot silently grant consent', async () => {
    const directory = await createDirectory();
    const file = join(directory, 'Analytics.json');
    const original = '{"version":1,"enabled":true,"installationId":"invalid"}';
    await writeFile(file, original);
    const store = new AnalyticsPreferences(directory);
    await expect(store.readPreferences()).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(original);
  });
});
