import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import {
  DesktopPermissionState,
  PermissionGrant,
  PermissionArea,
  type DesktopPermissionStatus,
  type PermissionActionResult,
} from '#contracts/DesktopPermissions.js';
import { loadCuaSdk } from './LoadCuaSdk.js';

const runFile = promisify(execFile);

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

/** Map the native check executed in Tro's main process to the public contract. */
export function readHostPermissionStatus(grants: {
  accessibility: boolean;
  screenRecording: boolean;
}): DesktopPermissionStatus {
  const accessibility = readGrant(grants.accessibility);
  const screenRecording = readGrant(grants.screenRecording);
  const kind =
    accessibility === PermissionGrant.GRANTED && screenRecording === PermissionGrant.GRANTED
      ? DesktopPermissionState.READY
      : accessibility === PermissionGrant.MISSING || screenRecording === PermissionGrant.MISSING
        ? DesktopPermissionState.NEEDS_PERMISSION
        : DesktopPermissionState.UNKNOWN;
  return { kind, accessibility, screenRecording };
}

/** Tro owns macOS permission UX. Status reads never start a driver or prompt;
 * a renderer can request access but cannot supply a command or Settings URL. */
export class DesktopPermissions {
  async readStatus(): Promise<DesktopPermissionStatus> {
    if (process.platform !== 'darwin') {
      return {
        kind: DesktopPermissionState.READY,
        accessibility: PermissionGrant.NOT_REQUIRED,
        screenRecording: PermissionGrant.NOT_REQUIRED,
      };
    }
    try {
      const sdk = await loadCuaSdk();
      return readHostPermissionStatus(sdk.readPermissions());
    } catch {
      return unknownStatus;
    }
  }

  async requestPermissions(): Promise<PermissionActionResult> {
    if (process.platform !== 'darwin') {
      return { kind: 'failed', message: 'macOS permission setup is unavailable on this system.' };
    }
    try {
      const sdk = await loadCuaSdk();
      /* This native call executes in the importing host, so its OS prompts
         identify Tro rather than a separately launched CuaDriver.app. */
      sdk.requestPermissions();
      return await this.openSettings(PermissionArea.ACCESSIBILITY);
    } catch {
      return { kind: 'failed', message: 'Could not start Tro permission setup.' };
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
}
