import type { App } from 'electron';
import { join } from 'node:path';
import {
  DesktopBundleId,
  DesktopDevelopmentApp,
  selectDesktopHostBundleId,
} from '../DesktopIdentity.js';

/** Run before readiness or session creation: both Vite and Finder launches must
 * select the development Keychain namespace and profile before encrypted I/O. */
export function configureDevelopmentStorage(
  app: Pick<App, 'isPackaged' | 'setName' | 'getPath' | 'setPath'>,
  executablePath: string,
): void {
  const bundleId = selectDesktopHostBundleId(app.isPackaged, executablePath);
  if (app.isPackaged && !bundleId.startsWith(`${DesktopBundleId.DEVELOPMENT}.`)) {
    return;
  }

  const directory = join(app.getPath('appData'), DesktopDevelopmentApp.NAME);
  app.setName(DesktopDevelopmentApp.NAME);
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
}
