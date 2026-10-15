import { createHash } from 'node:crypto';

export const DesktopBundleId = {
  INSTALLED: 'app.tro.desktop',
  DEVELOPMENT: 'app.tro.desktop.development',
  ELECTRON: 'com.github.Electron',
} as const;

export const DesktopDevelopmentApp = {
  NAME: 'tro-dev',
  BUNDLE_FILE: 'tro-dev.app',
} as const;

const developmentExecutableSuffix = `/.tro-development/${DesktopDevelopmentApp.BUNDLE_FILE}/Contents/MacOS/Electron`;

/** Different checkouts need distinct LaunchServices identities to receive their own callbacks. */
export function createDevelopmentBundleId(projectDirectory: string): string {
  const checkoutId = createHash('sha256').update(projectDirectory).digest('hex').slice(0, 12);
  return `${DesktopBundleId.DEVELOPMENT}.${checkoutId}`;
}

/** Match the actual executable before considering packaging; development keeps Electron's binary name. */
export function selectDesktopHostBundleId(isPackaged: boolean, executablePath: string): string {
  if (executablePath.endsWith(developmentExecutableSuffix)) {
    return createDevelopmentBundleId(executablePath.slice(0, -developmentExecutableSuffix.length));
  }
  return isPackaged ? DesktopBundleId.INSTALLED : DesktopBundleId.ELECTRON;
}
