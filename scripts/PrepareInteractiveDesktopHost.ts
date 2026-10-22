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
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  createDevelopmentBundleId,
  DesktopDevelopmentApp,
} from '../src/desktop/DesktopIdentity.js';
import { prepareCuaSdk } from './PrepareCuaSdk.js';
import { prepareDesktopDevelopmentHost } from './PrepareDesktopDevelopmentHost.js';

const runFile = promisify(execFile);

export interface ArchiveFileSystemRuntime {
  versions: { electron?: string | undefined };
  noAsar?: boolean | undefined;
}

/** This serialized startup CLI copies signed bundles as physical directories.
 * Electron otherwise treats embedded .asar files as virtual directories during
 * recursive cp/rm. Keep physical mode through awaited staging cleanup, then
 * restore the exact prior setting; ordinary Node processes remain untouched. */
export async function runWithPhysicalArchiveFiles<T>(
  operation: () => Promise<T>,
  runtime: ArchiveFileSystemRuntime = process,
): Promise<T> {
  if (!runtime.versions.electron) {
    return operation();
  }
  const hadSetting = Object.hasOwn(runtime, 'noAsar');
  const previous = runtime.noAsar;
  runtime.noAsar = true;
  try {
    return await operation();
  } finally {
    if (hadSetting) {
      runtime.noAsar = previous;
    } else {
      Reflect.deleteProperty(runtime, 'noAsar');
    }
  }
}
const bootstrap = `import { app } from 'electron';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, root] = process.argv.slice(1);
if (typeof entry !== 'string' || typeof root !== 'string' || !isAbsolute(entry) || !isAbsolute(root) || entry !== join(root, 'main', 'RunInteractiveEvaluationApp.js')) {
  throw new Error('invalid_interactive_evaluation_entry');
}
app.setName('tro-evaluation');
await import(pathToFileURL(entry).href);
`;

/** Keep the evaluation executable at the development-driver identity suffix,
 * under a distinct stable root so macOS grants survive disposable run profiles. */
export function createInteractiveDesktopHostLayout(projectDirectory: string): {
  evaluationDirectory: string;
  hostDirectory: string;
  destination: string;
  executable: string;
  bundleId: string;
} {
  const evaluationDirectory = resolve(projectDirectory, '.tro-development', 'InteractiveHost');
  const hostDirectory = join(evaluationDirectory, '.tro-development');
  const destination = join(hostDirectory, DesktopDevelopmentApp.BUNDLE_FILE);
  return {
    evaluationDirectory,
    hostDirectory,
    destination,
    executable: join(destination, 'Contents', 'MacOS', 'Electron'),
    bundleId: createDevelopmentBundleId(evaluationDirectory),
  };
}

/** Prepare an isolated, stable evaluation host without changing the real
 * development bundle. Only nonsecret entry/root arguments vary between runs;
 * credentials and disposable profiles never become signed bundle contents. */
export async function prepareInteractiveDesktopHost(): Promise<string> {
  return runWithPhysicalArchiveFiles(prepareInteractiveDesktopHostFiles);
}

async function prepareInteractiveDesktopHostFiles(): Promise<string> {
  const projectRoot = await realpath(process.cwd());
  const sourceExecutable = await prepareDesktopDevelopmentHost(projectRoot);
  if (process.platform !== 'darwin') {
    return sourceExecutable;
  }
  const layout = createInteractiveDesktopHostLayout(projectRoot);
  await mkdir(layout.evaluationDirectory, { recursive: true, mode: 0o700 });
  const evaluationDirectory = await realpath(layout.evaluationDirectory);
  if (evaluationDirectory !== layout.evaluationDirectory) {
    throw new Error('interactive_host_directory_must_not_be_symlinked');
  }
  await rejectRunningInteractiveHost(layout.executable);
  const sourceStamp = await readFile(
    join(projectRoot, '.tro-development', 'HostStamp.txt'),
    'utf8',
  );
  const rawSdkMetadata: unknown = JSON.parse(
    await readFile(
      join(projectRoot, 'node_modules', '@trycua', 'cua-driver', 'package.json'),
      'utf8',
    ),
  );
  const sdkMetadata = z.object({ version: z.string().min(1) }).parse(rawSdkMetadata);
  const lockfile = await readFile(join(projectRoot, 'pnpm-lock.yaml'));
  const stamp = createHash('sha256')
    .update('interactive-desktop-host-v1')
    .update(sourceStamp)
    .update(bootstrap)
    .update(layout.bundleId)
    .update(sdkMetadata.version)
    .update(lockfile)
    .digest('hex');
  const stampPath = join(layout.hostDirectory, 'HostStamp.txt');
  try {
    if ((await readFile(stampPath, 'utf8')).trim() === stamp) {
      await access(layout.executable);
      return layout.executable;
    }
  } catch {
    /* Build missing or stale contents in a private staging directory. */
  }
  await mkdir(layout.hostDirectory, { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(join(layout.hostDirectory, 'stage-'));
  try {
    const stagedApp = join(stagingDirectory, DesktopDevelopmentApp.BUNDLE_FILE);
    await cp(resolve(dirname(sourceExecutable), '../..'), stagedApp, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const plist = join(stagedApp, 'Contents', 'Info.plist');
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: layout.bundleId,
      CFBundleName: 'tro-evaluation',
      CFBundleDisplayName: 'Tro Evaluation',
    })) {
      await runFile('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
    }
    /* A disposable evaluation host must not claim the real app's OAuth scheme. */
    await runFile('/usr/bin/plutil', ['-remove', 'CFBundleURLTypes', plist]);
    const resourcesDirectory = join(stagedApp, 'Contents', 'Resources');
    const appDirectory = join(resourcesDirectory, 'app');
    await rm(appDirectory, { recursive: true, force: true });
    await mkdir(appDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(appDirectory, 'package.json'),
      JSON.stringify({
        name: 'tro-interactive-evaluation',
        type: 'module',
        main: 'EvaluationEntry.js',
      }),
      { mode: 0o600 },
    );
    await writeFile(join(appDirectory, 'EvaluationEntry.js'), bootstrap, { mode: 0o600 });
    await prepareCuaSdk(join(resourcesDirectory, 'cua-sdk'));
    await runFile(
      '/usr/bin/codesign',
      ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', stagedApp],
      { timeout: 60_000 },
    );
    await rejectRunningInteractiveHost(layout.executable);
    await rm(layout.destination, { recursive: true, force: true });
    await rename(stagedApp, layout.destination);
    await writeFile(stampPath, `${stamp}\n`, { mode: 0o600 });
    return layout.executable;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

/* Read executable paths only; arguments can carry unrelated private data. */
async function rejectRunningInteractiveHost(executable: string): Promise<void> {
  const { stdout } = await runFile('/bin/ps', ['-axo', 'comm='], { timeout: 5000 });
  if (stdout.split('\n').some((path) => path.trim() === executable)) {
    throw new Error('Quit the existing Tro evaluation host before starting another evaluation.');
  }
}
