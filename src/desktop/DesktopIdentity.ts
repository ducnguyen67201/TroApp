export const DesktopBundleId = {
  INSTALLED: 'app.tro.desktop',
  DEVELOPMENT: 'app.tro.desktop.development',
  ELECTRON: 'com.github.Electron',
} as const;

/** Match the host launched by StartDesktop.ts; direct Electron runs keep their own identity.
 * The native driver independently verifies the supplied bundle identity. */
export function selectDesktopHostBundleId(isPackaged: boolean, executablePath: string): string {
  if (isPackaged) {
    return DesktopBundleId.INSTALLED;
  }
  if (executablePath.endsWith('/.tro-development/Tro.app/Contents/MacOS/Electron')) {
    return DesktopBundleId.DEVELOPMENT;
  }
  return DesktopBundleId.ELECTRON;
}
