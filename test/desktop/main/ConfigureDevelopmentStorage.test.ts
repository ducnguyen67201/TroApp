import type { App } from 'electron';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { configureDevelopmentStorage } from '../../../src/desktop/main/ConfigureDevelopmentStorage.js';

function createApp(isPackaged: boolean) {
  return {
    isPackaged,
    setName: vi.fn<App['setName']>(),
    getPath: vi.fn<App['getPath']>(() => '/profiles'),
    setPath: vi.fn<App['setPath']>(),
  };
}

it.each([
  { isPackaged: false, executable: '/electron' },
  { isPackaged: false, executable: '/repo/.tro-development/tro-dev.app/Contents/MacOS/Electron' },
  { isPackaged: true, executable: '/repo/.tro-development/tro-dev.app/Contents/MacOS/Electron' },
])(
  'isolates development storage for $executable (packaged=$isPackaged)',
  ({ isPackaged, executable }) => {
    const app = createApp(isPackaged);
    configureDevelopmentStorage(app, executable);

    expect(app.setName).toHaveBeenCalledExactlyOnceWith('tro-dev');
    expect(app.setPath.mock.calls).toEqual([
      ['userData', join('/profiles', 'tro-dev')],
      ['sessionData', join('/profiles', 'tro-dev')],
    ]);
  },
);

it('preserves the installed release name and all storage paths', () => {
  const app = createApp(true);
  configureDevelopmentStorage(app, '/Applications/Tro.app/Contents/MacOS/Tro');

  expect(app.setName).not.toHaveBeenCalled();
  expect(app.setPath).not.toHaveBeenCalled();
  expect(app.getPath).not.toHaveBeenCalled();
});
