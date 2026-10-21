import { expect, it } from 'vitest';
import { createInteractiveDesktopHostLayout } from '../../scripts/PrepareInteractiveDesktopHost.js';
import {
  createDevelopmentBundleId,
  selectDesktopHostBundleId,
} from '../../src/desktop/DesktopIdentity.js';

it.skipIf(process.platform === 'win32')(
  'keeps native driver attribution equal to the stable evaluation bundle identity',
  () => {
    const layout = createInteractiveDesktopHostLayout('/repo');
    expect(layout.executable).toBe(
      '/repo/.tro-development/InteractiveHost/.tro-development/tro-dev.app/Contents/MacOS/Electron',
    );
    expect(layout.bundleId).toBe(createDevelopmentBundleId(layout.evaluationDirectory));
    expect(selectDesktopHostBundleId(false, layout.executable)).toBe(layout.bundleId);
    expect(selectDesktopHostBundleId(true, layout.executable)).toBe(layout.bundleId);
    expect(layout.bundleId).not.toBe(createDevelopmentBundleId('/repo'));
  },
);

it('reuses one evaluation identity across runs but separates different checkouts', () => {
  expect(createInteractiveDesktopHostLayout('/repo')).toEqual(
    createInteractiveDesktopHostLayout('/repo'),
  );
  expect(createInteractiveDesktopHostLayout('/other/repo').bundleId).not.toBe(
    createInteractiveDesktopHostLayout('/repo').bundleId,
  );
});
