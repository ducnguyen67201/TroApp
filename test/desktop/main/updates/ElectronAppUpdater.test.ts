import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdater } from 'electron-updater';
import { createElectronAppUpdater } from '../../../../src/desktop/main/updates/ElectronAppUpdater.js';
import type { AppUpdaterEvent } from '../../../../src/desktop/main/updates/AppUpdateController.js';

const doubles = vi.hoisted(() => {
  const listeners = new Map<string, (raw: unknown) => void>();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    disableWebInstaller: false,
    logger: null,
    checkForUpdates: vi.fn<AppUpdater['checkForUpdates']>().mockResolvedValue(null),
    downloadUpdate: vi.fn<AppUpdater['downloadUpdate']>().mockResolvedValue([]),
    quitAndInstall: vi.fn<AppUpdater['quitAndInstall']>(),
  } satisfies Pick<
    AppUpdater,
    | 'autoDownload'
    | 'autoInstallOnAppQuit'
    | 'allowPrerelease'
    | 'allowDowngrade'
    | 'disableWebInstaller'
    | 'logger'
    | 'checkForUpdates'
    | 'downloadUpdate'
    | 'quitAndInstall'
  >;
  return {
    listeners,
    updater: {
      ...updater,
      on: (name: string, listener: (raw: unknown) => void) => {
        listeners.set(name, listener);
      },
      removeListener: (name: string) => {
        listeners.delete(name);
      },
    },
  };
});

vi.mock('electron-updater', () => ({ default: { autoUpdater: doubles.updater } }));

beforeEach(() => {
  doubles.listeners.clear();
  vi.clearAllMocks();
});

describe('Electron updater adapter', () => {
  it('requires explicit download/install and keeps stable releases', async () => {
    const updater = createElectronAppUpdater();
    expect(doubles.updater.autoDownload).toBe(false);
    expect(doubles.updater.autoInstallOnAppQuit).toBe(false);
    expect(doubles.updater.allowPrerelease).toBe(false);
    expect(doubles.updater.allowDowngrade).toBe(false);
    expect(doubles.updater.disableWebInstaller).toBe(true);
    expect(doubles.updater.logger).toBeNull();
    await updater.checkForUpdates();
    expect(doubles.updater.downloadUpdate).not.toHaveBeenCalled();
    await updater.downloadUpdate();
    expect(doubles.updater.quitAndInstall).not.toHaveBeenCalled();
    updater.quitAndInstall();
    expect(doubles.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('validates third-party payloads and strips paths, URLs and diagnostics', () => {
    const receive = vi.fn<(event: AppUpdaterEvent) => void>();
    const unsubscribe = createElectronAppUpdater().subscribe(receive);
    doubles.listeners.get('update-available')?.({
      version: '0.2.0',
      files: [{ url: 'private URL' }],
    });
    expect(receive).toHaveBeenLastCalledWith({ kind: 'available', version: '0.2.0' });
    doubles.listeners.get('update-downloaded')?.({
      version: '0.2.0',
      downloadedFile: '/private/installer',
    });
    expect(receive).toHaveBeenLastCalledWith({ kind: 'downloaded', version: '0.2.0' });
    doubles.listeners.get('update-available')?.({ version: 123 });
    expect(receive).toHaveBeenLastCalledWith({ kind: 'failed' });
    doubles.listeners.get('error')?.(new Error('private URL and path'));
    expect(receive).toHaveBeenLastCalledWith({ kind: 'failed' });
    doubles.listeners.get('download-progress')?.({ percent: 48, transferred: 1000 });
    expect(receive).toHaveBeenLastCalledWith({ kind: 'progress', percent: 48 });
    const count = receive.mock.calls.length;
    doubles.listeners.get('download-progress')?.({ percent: Number.NaN });
    expect(receive.mock.calls).toHaveLength(count);
    unsubscribe();
    expect(doubles.listeners.size).toBe(0);
  });
});
