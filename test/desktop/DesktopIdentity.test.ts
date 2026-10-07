import { expect, it } from 'vitest';
import {
  createDevelopmentBundleId,
  DesktopBundleId,
  selectDesktopHostBundleId,
} from '../../src/desktop/DesktopIdentity.js';

it('attributes permissions to the installed, branded development, or direct Electron host', () => {
  expect(selectDesktopHostBundleId(true, '/Applications/Tro.app/Contents/MacOS/Tro')).toBe(
    DesktopBundleId.INSTALLED,
  );
  expect(
    selectDesktopHostBundleId(false, '/repo/.tro-development/Tro.app/Contents/MacOS/Electron'),
  ).toBe(createDevelopmentBundleId('/repo'));
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

it('keeps each checkout identity stable and separates it from other Tro checkouts', () => {
  const first = createDevelopmentBundleId('/repo');
  expect(first).toMatch(/^app\.tro\.desktop\.development\.[a-f0-9]{12}$/);
  expect(createDevelopmentBundleId('/repo')).toBe(first);
  expect(createDevelopmentBundleId('/other/repo')).not.toBe(first);
  expect(
    selectDesktopHostBundleId(true, '/repo/.tro-development/Tro.app/Contents/MacOS/Electron'),
  ).toBe(first);
});
