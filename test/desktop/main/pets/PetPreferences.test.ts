import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createPetPreferences,
  PetId,
  PetPreferencesSchema,
  PetCommandSchema,
  PetAction,
} from '#contracts/Pet.js';
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

it.each(['cat', 'fox', 'slime'] as const)(
  'upgrades saved version-one %s preferences without rewriting the original',
  async (activePetId) => {
    const directory = await mkdtemp(join(tmpdir(), 'tro-pets-upgrade-'));
    directories.push(directory);
    const store = new PetPreferences(directory);
    const accountId = 'legacy-student';
    const file = join(directory, createHash('sha256').update(accountId).digest('hex') + '.json');
    const legacy = {
      ...createPetPreferences(),
      version: 1,
      activePetId,
      enabled: true,
      names: { cat: 'Custom cat', fox: 'Custom fox', slime: 'Custom slime' },
      quiet: true,
      motion: 'reduced',
      locale: 'en',
      placement: { displayId: 42, horizontalRatio: 0.25, verticalRatio: 0.75 },
    };
    const original = JSON.stringify(legacy);
    await writeFile(file, original);
    const migrated = await store.readPreferences(accountId);
    expect(migrated).toEqual({
      ...legacy,
      version: 2,
      activePetId: activePetId === 'slime' ? PetId.CAT : activePetId,
      enabled: activePetId !== 'slime',
      names: { cat: legacy.names.cat, fox: legacy.names.fox },
    });
    expect(await readFile(file, 'utf8')).toBe(original);
    await store.savePreferences(accountId, migrated);
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    expect(PetPreferencesSchema.parse(saved)).toEqual(migrated);
    expect(await store.readPreferences(accountId)).toEqual(migrated);
  },
);

it('rejects adopting the retired mascot', () => {
  expect(
    PetCommandSchema.safeParse({
      kind: PetAction.ADOPT,
      petId: 'slime',
      name: 'Jelly',
      locale: 'en',
    }).success,
  ).toBe(false);
});
