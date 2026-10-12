import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  WhatsNewPreferences,
  type SavedWhatsNewPreferences,
} from '../../../../src/desktop/main/updates/WhatsNewPreferences.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.length = 0;
});

it('persists installation-scoped state atomically and preserves corrupt or unsupported files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-whats-new-'));
  directories.push(directory);
  const store = new WhatsNewPreferences(directory);
  expect(await store.readPreferences()).toBeNull();
  const saved: SavedWhatsNewPreferences = {
    schemaVersion: 1,
    lastRunVersion: '0.2.0',
    lastSeenWhatsNewReleaseId: '0.2.0',
    pendingReleaseId: null,
  };
  await store.savePreferences(saved);
  expect(await new WhatsNewPreferences(directory).readPreferences()).toEqual(saved);
  expect(await readdir(directory)).toEqual(['WhatsNew.json']);
  const path = join(directory, 'WhatsNew.json');
  for (const contents of ['{invalid', JSON.stringify({ ...saved, schemaVersion: 99 })]) {
    await writeFile(path, contents);
    await expect(store.readPreferences()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(contents);
  }
});
