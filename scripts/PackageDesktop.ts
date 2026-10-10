import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, WinPackager } from 'electron-builder';
import { z } from 'zod';
import { prepareCuaCompanion } from './PrepareCuaCompanion.js';
import { readWindowsSigningEnv } from './Env.js';
import {
  createWindowsSigningConfig,
  signAndVerifyWindowsFile,
  signWindowsResources,
} from './WindowsSigning.js';

const signingSettings = readWindowsSigningEnv(process.env, process.platform, process.arch);
const signingConfig = createWindowsSigningConfig(signingSettings);

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
      ...signingConfig,
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
        if (signingSettings.enabled) {
          const packager = context.packager;
          if (!(packager instanceof WinPackager)) {
            throw new Error('Windows release requires a Windows packager.');
          }
          /* NSIS deletes its temporary uninstaller before final artifact verification.
           * Wrap this packager instance's signing boundary to verify it before embedding. */
          const signFile = packager.signIf.bind(packager);
          packager.signIf = (path) => signAndVerifyWindowsFile(path, signFile);
          await signWindowsResources(context.appOutDir, (path) => packager.signIf(path));
        }
      },
    },
  });
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
