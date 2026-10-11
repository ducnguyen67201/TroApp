import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PetWorldCommandKind, PetRecognitionCategory } from '#contracts/PetWorld.js';
import { PetWorldPreferences } from '../../../../src/desktop/main/petWorld/PetWorldPreferences.js';
import { createPetWorldLocalState } from '../../../../src/desktop/main/petWorld/PetWorldLocalState.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('account-scoped pet world intent persistence', () => {
  it('survives restart, isolates accounts, and never uses the account ID as a path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tro-pet-world-'));
    directories.push(directory);
    const store = new PetWorldPreferences(directory);
    const state = {
      ...createPetWorldLocalState(),
      pending: [
        {
          kind: PetWorldCommandKind.GRANT_POINTS,
          requestId: 'ca73db43-ec47-4fb8-975c-54eabfef9e20',
          classId: 'da73db43-ec47-4fb8-975c-54eabfef9e20',
          studentIds: ['student'],
          pointsPerStudent: '123',
          category: PetRecognitionCategory.CURIOSITY,
        },
      ],
    };
    await store.saveState('../teacher@example.test', state);
    const restarted = new PetWorldPreferences(directory);
    expect(await restarted.readState('../teacher@example.test')).toEqual(state);
    expect(await restarted.readState('different-account')).toEqual(createPetWorldLocalState());
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it('preserves damaged data instead of clearing unresolved intents silently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tro-pet-world-'));
    directories.push(directory);
    const store = new PetWorldPreferences(directory);
    await store.saveState('student', createPetWorldLocalState());
    const [file] = await readdir(directory);
    if (!file) {
      throw new Error('Missing saved state');
    }
    const path = join(directory, file);
    await writeFile(path, '{damaged');
    await expect(store.readState('student')).rejects.toThrow('local state is unavailable');
    expect(await readFile(path, 'utf8')).toBe('{damaged');
  });
});
