import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPetPreferences } from '#contracts/Pet.js';
import { PetPreferences } from '../../../../src/desktop/main/pets/PetPreferences.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.length = 0;
});

it('isolates accounts, prevents path traversal and preserves corrupt files during recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tro-pets-'));
  directories.push(directory);
  const store = new PetPreferences(directory);
  const preferences = { ...createPetPreferences(), enabled: true };
  await store.savePreferences('../student@example.test', preferences);
  expect(await store.readPreferences('../student@example.test')).toEqual(preferences);
  expect(await store.readPreferences('different-student')).toEqual(createPetPreferences());
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const file = files[0];
  if (!file) {
    throw new Error('Missing saved preferences');
  }
  expect(file).toMatch(/^[a-f0-9]{64}\.json$/);
  await writeFile(join(directory, file), '{broken');
  expect(await store.readPreferences('../student@example.test')).toEqual(createPetPreferences());
  expect(await readFile(join(directory, file), 'utf8')).toBe('{broken');
});
