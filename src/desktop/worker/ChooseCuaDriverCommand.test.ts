import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { chooseCuaDriverCommand } from './ChooseCuaDriverCommand.js';

const temporaryDirectories: string[] = [];

async function createExecutable(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'driver fixture');
  await chmod(path, 0o755);
}

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

it('uses the bundled macOS driver before the development cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tro-driver-choice-'));
  temporaryDirectories.push(root);
  const resourcesPath = join(root, 'resources');
  const homeDirectory = join(root, 'home');
  const packagedApp = join(resourcesPath, 'cua-driver');
  const cachedApp = join(homeDirectory, '.cache', 'tro', 'cua-driver');
  await createExecutable(join(packagedApp, 'cua-driver'));
  await createExecutable(join(cachedApp, 'cua-driver'));

  await expect(
    chooseCuaDriverCommand({ resourcesPath, homeDirectory, platform: 'darwin' }),
  ).resolves.toEqual({
    command: join(packagedApp, 'cua-driver'),
  });
});

it('uses the cached Windows driver when no packaged executable exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tro-driver-choice-'));
  temporaryDirectories.push(root);
  const resourcesPath = join(root, 'resources');
  const homeDirectory = join(root, 'home');
  const command = join(homeDirectory, '.cache', 'tro', 'cua-driver', 'cua-driver.exe');
  await createExecutable(command);

  await expect(
    chooseCuaDriverCommand({ resourcesPath, homeDirectory, platform: 'win32' }),
  ).resolves.toEqual({ command });
});

it('does not use an independent macOS app when Tro has no prepared driver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tro-driver-choice-'));
  temporaryDirectories.push(root);
  const homeDirectory = join(root, 'home');
  await createExecutable(join(homeDirectory, '.local', 'bin', 'cua-driver'));
  await expect(
    chooseCuaDriverCommand({
      resourcesPath: join(root, 'resources'),
      homeDirectory,
      platform: 'darwin',
    }),
  ).rejects.toThrow('bundled Tro desktop driver');
});
