import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'electron-builder';
import { z } from 'zod';
import { prepareCuaCompanion } from './PrepareCuaCompanion.js';

/* electron-builder discovers this repository's pnpm workspace when out/ is
   inside the root. Stage the already-built app outside that workspace so its
   small package.json, rather than the backend lockfile, owns dependency
   collection. Remove the stage even if packaging fails. */
const stageRoot = await mkdtemp(join(tmpdir(), 'tro-desktop-package-'));
const appDirectory = join(stageRoot, 'app');

try {
  await cp('out', appDirectory, { recursive: true });
  await prepareCuaCompanion(join(appDirectory, 'driver'));
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
          directories: { output: resolve('release'), buildResources: 'branding' },
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
    config: {
      afterPack: async (context) => {
        const resourcesPath = context.packager.getResourcesDir(context.appOutDir);
        /* electron-builder skips a node_modules directory at a resource
           matcher's root. Verify the physical SDK survived resource copying
           before this app can be signed or handed to a user. */
        for (const entry of [
          join('cua-sdk', 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js'),
          join('cua-sdk', 'node_modules', '@ubjs', 'core', 'dist', 'esm', 'index.js'),
          join('cua-sdk', 'node_modules', '@ubjs', 'node', 'typescript', 'dist', 'resolve-lib.js'),
          join('cua-driver', process.platform === 'darwin' ? 'cua-driver' : 'cua-driver.exe'),
        ]) {
          await access(join(resourcesPath, entry));
        }
      },
    },
  });
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
