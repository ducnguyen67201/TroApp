import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { DesktopBundleId } from '../src/desktop/DesktopIdentity.js';

const runFile = promisify(execFile);
const require = createRequire(import.meta.url);

/** Copy and brand a checkout-owned development host. The installed Electron
 * dependency and existing OS permission grants are never modified. */
export async function prepareDesktopDevelopmentHost(): Promise<string> {
  const electronPath = z.string().parse(require('electron'));
  if (process.platform !== 'darwin') {
    return electronPath;
  }
  const metadata: unknown = JSON.parse(await readFile('package.json', 'utf8'));
  const { devDependencies, build } = z
    .object({
      devDependencies: z.object({ electron: z.string() }),
      build: z.object({
        mac: z.object({ extendInfo: z.object({ NSMicrophoneUsageDescription: z.string() }) }),
      }),
    })
    .parse(metadata);
  const icon = await readFile('src/desktop/assets/TroIcon.icns');
  const stamp = createHash('sha256')
    .update('branded-development-v1')
    .update(devDependencies.electron)
    .update(DesktopBundleId.DEVELOPMENT)
    .update(build.mac.extendInfo.NSMicrophoneUsageDescription)
    .update(icon)
    .digest('hex');
  const developmentDirectory = resolve('.tro-development');
  const destination = join(developmentDirectory, 'Tro.app');
  const executable = join(destination, 'Contents', 'MacOS', 'Electron');
  const stampPath = join(developmentDirectory, 'HostStamp.txt');
  try {
    if ((await readFile(stampPath, 'utf8')).trim() === stamp) {
      await access(executable);
      return executable;
    }
  } catch {
    /* A missing or outdated host is rebuilt before launch. */
  }
  await mkdir(developmentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(developmentDirectory, 'stage-'));
  try {
    const stagedApp = join(stagingDirectory, 'Tro.app');
    const sourceApp = resolve(dirname(electronPath), '../..');
    await cp(sourceApp, stagedApp, { recursive: true, verbatimSymlinks: true });
    await writeFile(join(stagedApp, 'Contents', 'Resources', 'TroIcon.icns'), icon);
    const plist = join(stagedApp, 'Contents', 'Info.plist');
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: DesktopBundleId.DEVELOPMENT,
      CFBundleName: 'Tro',
      CFBundleDisplayName: 'Tro',
      CFBundleIconFile: 'TroIcon.icns',
      NSMicrophoneUsageDescription: build.mac.extendInfo.NSMicrophoneUsageDescription,
    })) {
      await runFile('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
    }
    /* Bundle metadata invalidates Electron's signature. Sign only this local
       copy ad hoc, retaining Electron's runtime entitlements. */
    await runFile(
      '/usr/bin/codesign',
      ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', stagedApp],
      { timeout: 60_000 },
    );
    await rm(destination, { recursive: true, force: true });
    await rename(stagedApp, destination);
    await writeFile(stampPath, `${stamp}\n`);
    return executable;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
