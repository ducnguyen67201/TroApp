import { access, constants, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CuaCompanionBuildSchema } from '#contracts/CuaCompanionBuild.js';

async function hasCompanionBuild(directory: string): Promise<boolean> {
  try {
    const metadata: unknown = JSON.parse(
      await readFile(join(directory, 'CompanionBuild.json'), 'utf8'),
    );
    return CuaCompanionBuildSchema.safeParse(metadata).success;
  } catch {
    return false;
  }
}

export interface CuaDriverCommand {
  command: string;
}

interface DriverLocations {
  resourcesPath: string;
  homeDirectory: string;
  platform: NodeJS.Platform;
}

async function findExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the release shipped with Tro before any independent installation.
 * Packaged apps use resources; development uses the verified local cache. */
export async function chooseCuaDriverCommand(
  locations: DriverLocations = {
    resourcesPath: process.resourcesPath,
    homeDirectory: homedir(),
    platform: process.platform,
  },
): Promise<CuaDriverCommand> {
  const companionDirectory = join(locations.homeDirectory, '.cache', 'tro', 'cua-companion');
  const directories = [
    join(locations.resourcesPath, 'cua-driver'),
    ...(locations.platform === 'darwin' && (await hasCompanionBuild(companionDirectory))
      ? [companionDirectory]
      : []),
    join(locations.homeDirectory, '.cache', 'tro', 'cua-driver'),
  ];
  for (const directory of directories) {
    if (locations.platform === 'darwin') {
      const command = join(directory, 'cua-driver');
      if (await findExecutable(command)) {
        return { command };
      }
    } else if (locations.platform === 'win32') {
      const command = join(directory, 'cua-driver.exe');
      if (await findExecutable(command)) {
        return { command };
      }
    }
  }

  if (locations.platform === 'darwin') {
    throw new Error('The bundled Tro desktop driver is missing.');
  }

  return { command: 'cua-driver' };
}
