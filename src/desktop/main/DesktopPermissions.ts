import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { shell } from 'electron';
import { z } from 'zod';
import type { AgentChatPermissions } from './AgentChatPorts.js';
import {
  DesktopPermissionState,
  PermissionGrant,
  PermissionArea,
  type DesktopPermissionStatus,
  type PermissionActionResult,
} from '#contracts/DesktopPermissions.js';
import {
  chooseCuaDriverCommand,
  startCuaDriverApp,
  type CuaDriverCommand,
} from '../worker/ChooseCuaDriverCommand.js';

const runFile = promisify(execFile);
const driverStatusSchema = z.object({
  accessibility: z.boolean().optional(),
  screen_recording: z.boolean().optional(),
  source: z.object({ attribution: z.string(), executable: z.string().optional() }).optional(),
});

const macSettingsUrls = {
  [PermissionArea.ACCESSIBILITY]:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  [PermissionArea.SCREEN_RECORDING]:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
} as const;

const unknownStatus: DesktopPermissionStatus = {
  kind: DesktopPermissionState.UNKNOWN,
  accessibility: PermissionGrant.UNKNOWN,
  screenRecording: PermissionGrant.UNKNOWN,
};

function readGrant(granted: boolean | undefined): DesktopPermissionStatus['accessibility'] {
  if (granted === true) return PermissionGrant.GRANTED;
  if (granted === false) return PermissionGrant.MISSING;
  return PermissionGrant.UNKNOWN;
}

/** Trust only the CuaDriver daemon's own macOS grant report, not the terminal's. */
export function parseCuaPermissionStatus(
  output: string,
  expectedExecutable?: string,
): DesktopPermissionStatus {
  try {
    const data: unknown = JSON.parse(output);
    const parsed = driverStatusSchema.safeParse(data);
    if (
      !parsed.success ||
      parsed.data.source?.attribution !== 'driver-daemon' ||
      (expectedExecutable !== undefined && parsed.data.source.executable !== expectedExecutable)
    ) {
      return unknownStatus;
    }
    const accessibility = readGrant(parsed.data.accessibility);
    const screenRecording = readGrant(parsed.data.screen_recording);
    const kind =
      accessibility === PermissionGrant.GRANTED && screenRecording === PermissionGrant.GRANTED
        ? DesktopPermissionState.READY
        : accessibility === PermissionGrant.MISSING || screenRecording === PermissionGrant.MISSING
          ? DesktopPermissionState.NEEDS_PERMISSION
          : DesktopPermissionState.UNKNOWN;
    return { kind, accessibility, screenRecording };
  } catch {
    return unknownStatus;
  }
}

/** Main owns the fixed driver command and macOS Settings destinations.
 * A renderer can request the action, but cannot supply a command or URL. */
export class DesktopPermissions implements AgentChatPermissions {
  private installation: CuaDriverCommand | null = null;
  private launchPromise: Promise<CuaDriverCommand> | null = null;
  private grantProcess: ChildProcess | null = null;

  async readStatus(): Promise<DesktopPermissionStatus> {
    if (process.platform !== 'darwin') {
      return {
        kind: DesktopPermissionState.READY,
        accessibility: PermissionGrant.NOT_REQUIRED,
        screenRecording: PermissionGrant.NOT_REQUIRED,
      };
    }
    try {
      const installation = await this.ensureDriverRunning();
      const result = await runFile(
        installation.command,
        [
          'permissions',
          'status',
          '--json',
          ...(installation.socketPath ? ['--socket', installation.socketPath] : []),
        ],
        {
          timeout: 5000,
          maxBuffer: 64 * 1024,
        },
      );
      return parseCuaPermissionStatus(
        result.stdout,
        isAbsolute(installation.command) ? installation.command : undefined,
      );
    } catch {
      return unknownStatus;
    }
  }

  async requestPermissions(): Promise<PermissionActionResult> {
    if (process.platform !== 'darwin') {
      return { kind: 'failed', message: 'macOS permission setup is unavailable on this system.' };
    }
    try {
      const installation = await this.ensureDriverRunning();
      if (!this.grantProcess) {
        /* Cua owns the OS prompts. The command can remain active while the
           person enables both switches, so never block the renderer on it. */
        const child = spawn(
          installation.command,
          [
            'permissions',
            'grant',
            ...(installation.socketPath ? ['--socket', installation.socketPath] : []),
          ],
          {
            stdio: 'ignore',
            windowsHide: true,
          },
        );
        child.once('exit', () => {
          if (this.grantProcess === child) this.grantProcess = null;
        });
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        if (child.exitCode === null && child.signalCode === null) {
          this.grantProcess = child;
        }
      }
      return await this.openSettings(PermissionArea.ACCESSIBILITY);
    } catch {
      return { kind: 'failed', message: 'Could not start CuaDriver permission setup.' };
    }
  }

  async openSettings(area: PermissionArea): Promise<PermissionActionResult> {
    if (process.platform !== 'darwin') {
      return { kind: 'failed', message: 'System Settings is available on macOS only.' };
    }
    try {
      await shell.openExternal(macSettingsUrls[area]);
      return { kind: 'opened' };
    } catch {
      try {
        await runFile('/usr/bin/open', ['-a', 'System Settings'], { timeout: 5000 });
        return { kind: 'opened' };
      } catch {
        return { kind: 'failed', message: 'Open System Settings → Privacy & Security manually.' };
      }
    }
  }

  dispose(): void {
    this.grantProcess?.kill();
    this.grantProcess = null;
  }

  private async ensureDriverRunning(): Promise<CuaDriverCommand> {
    if (this.installation) return this.installation;
    this.launchPromise ??= (async () => {
      const installation = await chooseCuaDriverCommand();
      await startCuaDriverApp(installation);
      this.installation = installation;
      return installation;
    })();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }
}
