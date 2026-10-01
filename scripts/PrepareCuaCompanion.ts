import { createHash } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CuaCompanionBuildSchema } from '../src/contracts/CuaCompanionBuild.js';
import { prepareCuaDriver } from './PrepareCuaDriver.js';

/** Native source never enters Electron's bundle; only its built app does. */
export async function prepareCuaCompanion(destination: string): Promise<void> {
  if (process.platform !== 'darwin') {
    await prepareCuaDriver(destination);
    return;
  }
  const cache = join(homedir(), '.cache', 'tro', 'cua-companion');
  const raw: unknown = JSON.parse(await readFile(join(cache, 'CompanionBuild.json'), 'utf8'));
  const build = CuaCompanionBuildSchema.parse(raw);
  const patch = await readFile(new URL('../driver-patches/CursorCompanion.patch', import.meta.url));
  const executable = await readFile(
    join(cache, 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver'),
  );
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  if (
    build.patchSha256 !== digest(patch) ||
    build.executableSha256 !== digest(executable) ||
    build.architecture !== process.arch
  ) {
    throw new Error(
      'Native companion build does not match this source/architecture. Run pnpm build:cua.',
    );
  }
  await cp(cache, destination, { recursive: true });
}
