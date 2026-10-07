import { app } from 'electron';
import { realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DesktopAuthProtocol } from '../../DesktopAuthProtocol.js';

export const DesktopAuthCallbackError = {
  REGISTRATION: 'Tro could not register the sign-in callback. Restart the desktop launcher.',
  WRONG_APP: 'Another Tro app is receiving sign-in. Restart this desktop launcher.',
} as const;

interface CallbackRegistration {
  platform: NodeJS.Platform;
  executablePath: string;
  usesDefaultApp: boolean;
  entryPath: string | undefined;
  setDefault: (scheme: string, executable?: string, args?: string[]) => boolean;
  readApplication: (url: string) => Promise<{ path: string }>;
  resolvePath: (path: string) => Promise<string>;
}

/** Reassert ownership immediately before OAuth; another checkout may have registered since launch. */
export async function ensureDesktopAuthCallback(
  registration: CallbackRegistration = {
    platform: process.platform,
    executablePath: process.execPath,
    usesDefaultApp: process.defaultApp,
    entryPath: process.argv[1],
    setDefault: (scheme, executable, args) =>
      app.setAsDefaultProtocolClient(scheme, executable, args),
    readApplication: (url) => app.getApplicationInfoForProtocol(url),
    resolvePath: realpath,
  },
): Promise<void> {
  let registered: boolean;
  try {
    registered =
      registration.usesDefaultApp && registration.entryPath
        ? registration.setDefault(DesktopAuthProtocol.SCHEME, registration.executablePath, [
            resolve(registration.entryPath),
          ])
        : registration.setDefault(DesktopAuthProtocol.SCHEME);
  } catch {
    throw new Error(DesktopAuthCallbackError.REGISTRATION);
  }
  if (!registered) {
    throw new Error(DesktopAuthCallbackError.REGISTRATION);
  }
  if (registration.platform === 'darwin') {
    let application: { path: string };
    try {
      application = await registration.readApplication(DesktopAuthProtocol.CALLBACK_URL);
    } catch {
      throw new Error(DesktopAuthCallbackError.REGISTRATION);
    }
    const bundlePath = resolve(dirname(registration.executablePath), '../..');
    let paths: string[];
    try {
      paths = await Promise.all([
        registration.resolvePath(bundlePath),
        registration.resolvePath(application.path),
      ]);
    } catch {
      throw new Error(DesktopAuthCallbackError.REGISTRATION);
    }
    const [expected, actual] = paths;
    if (expected !== actual) {
      throw new Error(DesktopAuthCallbackError.WRONG_APP);
    }
  }
}
