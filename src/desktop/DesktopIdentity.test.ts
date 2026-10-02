import { expect, it } from 'vitest';
import { DesktopBundleId, selectDesktopHostBundleId } from './DesktopIdentity.js';

it('attributes permissions to the installed, branded development, or direct Electron host', () => {
  expect(selectDesktopHostBundleId(true, '/Applications/Tro.app/Contents/MacOS/Tro')).toBe(
    DesktopBundleId.INSTALLED,
  );
  expect(
    selectDesktopHostBundleId(false, '/repo/.tro-development/Tro.app/Contents/MacOS/Electron'),
  ).toBe(DesktopBundleId.DEVELOPMENT);
  expect(
    selectDesktopHostBundleId(
      false,
      '/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ),
  ).toBe(DesktopBundleId.ELECTRON);
  expect(selectDesktopHostBundleId(false, '/unrelated/Tro.app/Contents/MacOS/Electron')).toBe(
    DesktopBundleId.ELECTRON,
  );
});
