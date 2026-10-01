import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  const directories = [
    join(locations.resourcesPath, 'cua-driver'),
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
