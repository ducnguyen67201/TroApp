import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CuaCompanionBuildSchema } from '../src/contracts/CuaCompanionBuild.js';
import { validateWindowsCompanionExecutable } from './WindowsCompanionExecutable.js';

/** Check native provenance before reusing a build or copying it into a package. */
export async function validateCuaCompanion(
  cache: string,
  settings: { platform: NodeJS.Platform; architecture: string; patch: Uint8Array },
): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(join(cache, 'CompanionBuild.json'), 'utf8'));
  const build = CuaCompanionBuildSchema.parse(raw);
  const executable = await readFile(
    join(cache, settings.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'),
  );
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  if (
    build.patchSha256 !== digest(settings.patch) ||
    build.executableSha256 !== digest(executable) ||
    build.architecture !== settings.architecture
  ) {
    throw new Error(
      'Native companion build does not match this source/architecture. Run pnpm build:cua.',
    );
  }
  if (settings.platform === 'win32') {
    validateWindowsCompanionExecutable(executable);
  }
}

/** Native source never enters Electron's bundle; only its executable and runtime libraries do. */
export async function prepareCuaCompanion(destination: string): Promise<void> {
  const cache = join(homedir(), '.cache', 'tro', 'cua-companion');
  await validateCuaCompanion(cache, {
    platform: process.platform,
    architecture: process.arch,
    patch: await readFile(new URL('../driver-patches/CursorCompanion.patch', import.meta.url)),
  });
  /* Replace only the verified staging directory, preserving the embedded layout. */
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(cache, destination, { recursive: true });
}
