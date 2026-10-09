import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CuaCompanionBuild, CuaCompanionBuildSchema } from '../src/contracts/CuaCompanionBuild.js';
import { prepareCuaDriver } from './PrepareCuaDriver.js';

const runFile = promisify(execFile);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('Native teaching companion currently supports macOS arm64/x64 only.');
}
const cacheRoot = join(homedir(), '.cache', 'tro');
await mkdir(cacheRoot, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'tro-cua-companion-'));
const stage = await mkdtemp(join(cacheRoot, 'CompanionStage-'));
try {
  const source = join(temporary, 'source');
  await runFile(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      '--branch',
      'cua-driver-rs-v0.30.4',
      'https://github.com/trycua/cua.git',
      source,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  await runFile('git', ['sparse-checkout', 'set', 'libs/cua-driver'], { cwd: source });
  const head = await runFile('git', ['rev-parse', 'HEAD'], { cwd: source });
  if (head.stdout.trim() !== CuaCompanionBuild.SOURCE_COMMIT) {
    throw new Error('Cua source did not match the pinned commit.');
  }
  const patchPath = resolve('driver-patches/CursorCompanion.patch');
  const patch = await readFile(patchPath);
  await runFile('git', ['apply', patchPath], { cwd: source });
  const rustDirectory = join(source, 'libs', 'cua-driver', 'rust');
  const targetDirectory = join(cacheRoot, 'cua-companion-build');
  console.log('Building the pinned native Cua companion…');
  // Cargo resolves toolchain/runtime settings from its normal environment;
  // the only task override is a Tro-owned build cache, not user configuration.
  // Include transport and session lifecycle checks when changing control dispatch.
  const nativeTestSelections = [
    {
      packages: [
        'cua-driver',
        'cua-driver-contract',
        'cua-driver-core',
        'cursor-overlay',
        'platform-macos',
      ],
      filter: 'companion',
    },
    { packages: ['cua-driver'], filter: 'proxy::tests::' },
    { packages: ['cua-driver'], filter: 'mcp_envelope::tests::' },
    { packages: ['cua-driver-core'], filter: 'session::tests::' },
  ] as const;
  for (const selection of nativeTestSelections) {
    const nativeTests = await runFile(
      'cargo',
      [
        'test',
        '--locked',
        ...selection.packages.flatMap((packageName) => ['-p', packageName]),
        selection.filter,
        '--target-dir',
        targetDirectory,
      ],
      { cwd: rustDirectory, maxBuffer: 16 * 1024 * 1024 },
    );
    console.log(nativeTests.stdout.trim());
  }
  await runFile(
    'cargo',
    ['build', '--locked', '--release', '-p', 'cua-driver', '--target-dir', targetDirectory],
    { cwd: rustDirectory, maxBuffer: 16 * 1024 * 1024 },
  );
  await prepareCuaDriver(stage);
  const executablePath = join(stage, 'cua-driver');
  await cp(join(targetDirectory, 'release', 'cua-driver'), executablePath);
  /* Local ad-hoc signature; Tro's embedded host owns macOS attribution. */
  await runFile('/usr/bin/codesign', ['--force', '--sign', '-', executablePath]);
  const executableVersion = await runFile(executablePath, ['--version'], { maxBuffer: 4096 });
  if (executableVersion.stdout.trim().split(/\s+/).at(-1) !== CuaCompanionBuild.VERSION) {
    throw new Error('Native executable version does not match the companion build contract.');
  }
  const executable = await readFile(executablePath);
  const metadata = CuaCompanionBuildSchema.parse({
    version: CuaCompanionBuild.VERSION,
    sourceCommit: CuaCompanionBuild.SOURCE_COMMIT,
    patchSha256: digest(patch),
    executableSha256: digest(executable),
    architecture: process.arch,
  });
  await writeFile(join(stage, 'CompanionBuild.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(stage, 'DriverVersion.txt'), CuaCompanionBuild.VERSION + '\n');
  const destination = join(cacheRoot, 'cua-companion');
  await rm(destination, { recursive: true, force: true });
  await rename(stage, destination);
  console.log(
    `Built native companion at ${destination}. Grant desktop permissions to Tro before using guidance.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
  await rm(stage, { recursive: true, force: true });
}
