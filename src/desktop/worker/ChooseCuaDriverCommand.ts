import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export interface CuaDriverCommand {
  command: string;
  macAppPath?: string;
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
      const macAppPath = join(directory, 'CuaDriver.app');
      const command = join(macAppPath, 'Contents', 'MacOS', 'cua-driver');
      if (await findExecutable(command)) {
        return { command, macAppPath };
      }
    } else if (locations.platform === 'win32') {
      const command = join(directory, 'cua-driver.exe');
      if (await findExecutable(command)) {
        return { command };
      }
    }
  }

  if (locations.platform === 'darwin') {
    const command = join(locations.homeDirectory, '.local', 'bin', 'cua-driver');
    if (await findExecutable(command)) {
      return { command };
    }
  }

  return { command: 'cua-driver' };
}

/** Launch the packaged macOS app through LaunchServices so desktop grants
 * belong to CuaDriver.app, while MCP remains private to the worker. */
export async function startCuaDriverApp(installation: CuaDriverCommand): Promise<void> {
  if (!installation.macAppPath) {
    return;
  }

  try {
    const status = await runFile(installation.command, ['status'], { timeout: 3000 });
    if (status.stdout.includes('daemon is running')) {
      return;
    }
  } catch {
    /* A missing daemon is expected on the first task. */
  }

  await runFile('/usr/bin/open', ['-n', '-g', '-a', installation.macAppPath, '--args', 'serve'], {
    timeout: 5000,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const status = await runFile(installation.command, ['status'], { timeout: 3000 });
      if (status.stdout.includes('daemon is running')) {
        return;
      }
    } catch {
      /* Cua may still be opening its app bundle. */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Cua Driver did not become ready.');
}
