import electronUpdater, { type UpdaterEvents } from 'electron-updater';
import { z } from 'zod';
import { AppUpdateVersionSchema } from '#contracts/AppUpdate.js';
import type { AppUpdaterPort } from './AppUpdateController.js';

const updateInfoSchema = z.looseObject({ version: AppUpdateVersionSchema });
const progressSchema = z.looseObject({ percent: z.number() });

/** electron-builder supplies app-update.yml. Never accept a feed, file path or
 * installer URL from IPC. Keep third-party diagnostics out of ordinary logs. */
export function createElectronAppUpdater(): AppUpdaterPort {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = null;

  return {
    async checkForUpdates() {
      await autoUpdater.checkForUpdates();
    },
    async downloadUpdate() {
      await autoUpdater.downloadUpdate();
    },
    quitAndInstall() {
      autoUpdater.quitAndInstall(false, true);
    },
    subscribe(listener) {
      const emitVersion = (kind: 'available' | 'downloaded', raw: unknown): void => {
        const result = updateInfoSchema.safeParse(raw);
        listener(result.success ? { kind, version: result.data.version } : { kind: 'failed' });
      };
      const available = (raw: unknown): void => {
        emitVersion('available', raw);
      };
      const downloaded = (raw: unknown): void => {
        emitVersion('downloaded', raw);
      };
      const current = (): void => {
        listener({ kind: 'current' });
      };
      const failed = (): void => {
        listener({ kind: 'failed' });
      };
      const progress = (raw: unknown): void => {
        const result = progressSchema.safeParse(raw);
        if (result.success) {
          listener({ kind: 'progress', percent: result.data.percent });
        }
      };
      const listeners = [
        ['update-available', available],
        ['update-not-available', current],
        ['download-progress', progress],
        ['update-downloaded', downloaded],
        ['error', failed],
        ['update-cancelled', failed],
      ] satisfies [UpdaterEvents, (raw: unknown) => void][];
      for (const [name, receive] of listeners) {
        autoUpdater.on(name, receive);
      }
      return () => {
        for (const [name, receive] of listeners) {
          autoUpdater.removeListener(name, receive);
        }
      };
    },
  } satisfies AppUpdaterPort;
}
