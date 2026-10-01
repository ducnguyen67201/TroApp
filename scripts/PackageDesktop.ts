import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'electron-builder';
import { z } from 'zod';
import { prepareCuaDriver } from './PrepareCuaDriver.js';

/* electron-builder discovers this repository's pnpm workspace when out/ is
   inside the root. Stage the already-built app outside that workspace so its
   small package.json, rather than the backend lockfile, owns dependency
   collection. Remove the stage even if packaging fails. */
const stageRoot = await mkdtemp(join(tmpdir(), 'tro-desktop-package-'));
const appDirectory = join(stageRoot, 'app');

try {
  await cp('out', appDirectory, { recursive: true });
  await prepareCuaDriver(join(appDirectory, 'driver'));
  const rawPackage: unknown = JSON.parse(
    await readFile(join(appDirectory, 'package.json'), 'utf8'),
  );
  const appPackage = z.looseObject({ build: z.record(z.string(), z.unknown()) }).parse(rawPackage);

  await writeFile(
    join(appDirectory, 'package.json'),
    JSON.stringify(
      {
        ...appPackage,
        build: {
          ...appPackage.build,
          directories: { output: resolve('release') },
        },
      },
      null,
      2,
    ) + '\n',
  );

  await build({
    projectDir: appDirectory,
    dir: process.argv.includes('--dir'),
    publish: 'never',
  });
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
