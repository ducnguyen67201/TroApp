import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { DesktopAuthProtocol } from '../src/desktop/DesktopAuthProtocol.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createDevelopmentBundleId } from '../src/desktop/DesktopIdentity.js';

const runFile = promisify(execFile);
const require = createRequire(import.meta.url);

/** Copy and brand a checkout-owned development host. The installed Electron
 * dependency and existing OS permission grants are never modified. */
export async function prepareDesktopDevelopmentHost(
  projectDirectory = process.cwd(),
): Promise<string> {
  const electronPath = z.string().parse(require('electron'));
  if (process.platform !== 'darwin') {
    return electronPath;
  }
  const projectRoot = await realpath(projectDirectory);
  const metadata: unknown = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const { name, devDependencies, build } = z
    .object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      devDependencies: z.object({ electron: z.string() }),
      build: z.object({
        mac: z.object({ extendInfo: z.object({ NSMicrophoneUsageDescription: z.string() }) }),
      }),
    })
    .parse(metadata);
  const icon = await readFile(join(projectRoot, 'src/desktop/assets/TroIcon.icns'));
  const bootstrapSource = await readFile(
    join(projectRoot, 'src/desktop/main/StartDevelopmentHost.ts'),
    'utf8',
  );
  const bootstrap = transpileModule(bootstrapSource, {
    compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 },
  }).outputText;
  const bundleId = createDevelopmentBundleId(projectRoot);
  const stamp = createHash('sha256')
    .update('branded-development-v2')
    .update(projectRoot)
    .update(name)
    .update(bootstrap)
    .update(devDependencies.electron)
    .update(bundleId)
    .update(build.mac.extendInfo.NSMicrophoneUsageDescription)
    .update(icon)
    .digest('hex');
  const developmentDirectory = join(projectRoot, '.tro-development');
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
  await rejectRunningDevelopmentHost(executable);
  await mkdir(developmentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(developmentDirectory, 'stage-'));
  try {
    const stagedApp = join(stagingDirectory, 'Tro.app');
    const sourceApp = resolve(dirname(electronPath), '../..');
    await cp(sourceApp, stagedApp, { recursive: true, verbatimSymlinks: true });
    await writeFile(join(stagedApp, 'Contents', 'Resources', 'TroIcon.icns'), icon);
    const plist = join(stagedApp, 'Contents', 'Info.plist');
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: bundleId,
      CFBundleName: 'Tro',
      CFBundleDisplayName: 'Tro',
      CFBundleIconFile: 'TroIcon.icns',
      NSMicrophoneUsageDescription: build.mac.extendInfo.NSMicrophoneUsageDescription,
    })) {
      await runFile('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
    }
    await runFile('/usr/bin/plutil', [
      '-replace',
      'CFBundleURLTypes',
      '-json',
      JSON.stringify([
        { CFBundleURLName: bundleId, CFBundleURLSchemes: [DesktopAuthProtocol.SCHEME] },
      ]),
      plist,
    ]);
    const appDirectory = join(stagedApp, 'Contents', 'Resources', 'app');
    await mkdir(appDirectory, { recursive: true });
    await writeFile(
      join(appDirectory, 'package.json'),
      JSON.stringify({ name, type: 'module', main: 'StartDevelopmentHost.js' }),
    );
    await writeFile(
      join(appDirectory, 'HostConfig.json'),
      JSON.stringify({ projectDirectory: projectRoot, appName: name }),
      { mode: 0o600 },
    );
    await writeFile(join(appDirectory, 'StartDevelopmentHost.js'), bootstrap);
    /* Bundle metadata invalidates Electron's signature. Sign only this local
       copy ad hoc, retaining Electron's runtime entitlements. */
    await runFile(
      '/usr/bin/codesign',
      ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', stagedApp],
      { timeout: 60_000 },
    );
    await rejectRunningDevelopmentHost(executable);
    await rm(destination, { recursive: true, force: true });
    await rename(stagedApp, destination);
    await writeFile(stampPath, `${stamp}\n`);
    return executable;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

/* Inspect executable names, never command arguments containing OAuth callbacks. */
async function rejectRunningDevelopmentHost(executable: string): Promise<void> {
  const { stdout } = await runFile('/bin/ps', ['-axo', 'comm='], { timeout: 5000 });
  if (stdout.split('\n').some((path) => path.trim() === executable)) {
    throw new Error('Quit Tro before rebuilding its development host, then restart the launcher.');
  }
}
