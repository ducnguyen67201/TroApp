import { describe, expect, it, vi } from 'vitest';
import { AppUpdateState, AppUpdatePhase } from '#contracts/AppUpdate.js';
import {
  AppUpdateController,
  type AppUpdaterEvent,
  type AppUpdaterPort,
} from './AppUpdateController.js';
import { runAppUpdateCommand } from './AppUpdateCommand.js';

function createUpdates() {
  let receive: ((event: AppUpdaterEvent) => void) | undefined;
  const unsubscribe = vi.fn<() => void>();
  const updater = {
    checkForUpdates: vi.fn<AppUpdaterPort['checkForUpdates']>().mockImplementation(() => {
      receive?.({ kind: 'available', version: '0.2.0' });
      return Promise.resolve();
    }),
    downloadUpdate: vi.fn<AppUpdaterPort['downloadUpdate']>().mockImplementation(() => {
      receive?.({ kind: 'downloaded', version: '0.2.0' });
      return Promise.resolve();
    }),
    quitAndInstall: vi.fn<AppUpdaterPort['quitAndInstall']>(),
    subscribe: vi.fn<AppUpdaterPort['subscribe']>().mockImplementation((listener) => {
      receive = listener;
      return unsubscribe;
    }),
  } satisfies AppUpdaterPort;
  const emit = vi.fn<(snapshot: ReturnType<AppUpdateController['readStatus']>) => void>();
  const canRestart = vi.fn<() => boolean>().mockReturnValue(true);
  const requestRestart = vi.fn<() => void>();
  const controller = new AppUpdateController({ updater, emit, canRestart, requestRestart });
  return {
    controller,
    updater,
    emit,
    canRestart,
    requestRestart,
    unsubscribe,
    receive: (event: AppUpdaterEvent) => {
      receive?.(event);
    },
  };
}

describe('desktop app updates', () => {
  it('does not check, download or install when updates are disabled', async () => {
    const requestRestart = vi.fn<() => void>();
    const controller = new AppUpdateController({
      updater: null,
      emit: () => {},
      canRestart: () => true,
      requestRestart,
    });
    expect(controller.readStatus().status.state).toBe(AppUpdateState.DISABLED);
    expect((await controller.checkForUpdates()).kind).toBe('failed');
    expect((await controller.downloadUpdate()).kind).toBe('failed');
    expect(controller.restartForUpdate().kind).toBe('failed');
    controller.installAfterShutdown();
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('checks without downloading and installs only after an explicit restart and shutdown', async () => {
    const updates = createUpdates();
    await updates.controller.checkForUpdates();
    expect(updates.controller.readStatus().status).toEqual({
      state: AppUpdateState.AVAILABLE,
      version: '0.2.0',
    });
    expect(updates.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updates.controller.restartForUpdate().kind).toBe('failed');
    await updates.controller.downloadUpdate();
    expect(updates.controller.readStatus().status.state).toBe(AppUpdateState.READY);
    expect(updates.updater.quitAndInstall).not.toHaveBeenCalled();
    updates.canRestart.mockReturnValue(false);
    expect(updates.controller.restartForUpdate()).toEqual({ kind: 'failed', reason: 'busy' });
    expect(updates.requestRestart).not.toHaveBeenCalled();
    updates.canRestart.mockReturnValue(true);
    expect(updates.controller.restartForUpdate().kind).toBe('ok');
    expect(updates.requestRestart).toHaveBeenCalledOnce();
    expect(updates.updater.quitAndInstall).not.toHaveBeenCalled();
    updates.controller.installAfterShutdown();
    expect(updates.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(updates.controller.restartForUpdate().kind).toBe('failed');
  });

  it('deduplicates work, ignores unrelated events and bounds finite progress', async () => {
    const updates = createUpdates();
    let finish: (() => void) | undefined;
    updates.updater.checkForUpdates.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const checking = updates.controller.checkForUpdates();
    await updates.controller.checkForUpdates();
    expect(updates.updater.checkForUpdates).toHaveBeenCalledOnce();
    updates.receive({ kind: 'available', version: '0.2.0' });
    finish?.();
    await checking;
    updates.updater.downloadUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const downloading = updates.controller.downloadUpdate();
    await updates.controller.downloadUpdate();
    await updates.controller.checkForUpdates();
    expect(updates.updater.downloadUpdate).toHaveBeenCalledOnce();
    updates.receive({ kind: 'progress', percent: 150 });
    expect(updates.controller.readStatus().status).toEqual({
      state: AppUpdateState.DOWNLOADING,
      version: '0.2.0',
      percent: 100,
    });
    updates.receive({ kind: 'progress', percent: Number.NaN });
    updates.receive({ kind: 'current' });
    updates.receive({ kind: 'downloaded', version: '0.3.0' });
    expect(updates.controller.readStatus().status.state).toBe(AppUpdateState.DOWNLOADING);
    updates.receive({ kind: 'downloaded', version: '0.2.0' });
    finish?.();
    await downloading;
    const revision = updates.controller.readStatus().revision;
    updates.receive({ kind: 'failed' });
    expect(updates.controller.readStatus().revision).toBe(revision);
  });

  it('recovers from checks and downloads without exposing third-party diagnostics', async () => {
    const updates = createUpdates();
    updates.updater.checkForUpdates.mockRejectedValueOnce(new Error('private path and URL'));
    await updates.controller.checkForUpdates();
    expect(updates.controller.readStatus().status).toEqual({
      state: AppUpdateState.ERROR,
      phase: AppUpdatePhase.CHECK,
      version: null,
    });
    await updates.controller.checkForUpdates();
    updates.updater.downloadUpdate.mockRejectedValueOnce(new Error('private installer path'));
    await updates.controller.downloadUpdate();
    expect(updates.controller.readStatus().status).toEqual({
      state: AppUpdateState.ERROR,
      phase: AppUpdatePhase.DOWNLOAD,
      version: '0.2.0',
    });
    await updates.controller.downloadUpdate();
    expect(updates.controller.readStatus().status.state).toBe(AppUpdateState.READY);
  });

  it('keeps a failed installation retryable and ignores events after disposal', async () => {
    const updates = createUpdates();
    await updates.controller.checkForUpdates();
    await updates.controller.downloadUpdate();
    updates.controller.restartForUpdate();
    updates.updater.quitAndInstall.mockImplementationOnce(() => {
      updates.receive({ kind: 'failed' });
    });
    updates.controller.installAfterShutdown();
    expect(updates.controller.readStatus().status).toEqual({
      state: AppUpdateState.ERROR,
      phase: AppUpdatePhase.INSTALL,
      version: '0.2.0',
    });
    expect(updates.controller.restartForUpdate().kind).toBe('ok');
    updates.controller.dispose();
    const revision = updates.controller.readStatus().revision;
    updates.receive({ kind: 'failed' });
    expect(updates.controller.readStatus().revision).toBe(revision);
    expect(updates.unsubscribe).toHaveBeenCalledOnce();
  });

  it('rejects untrusted senders, invalid commands and renderer-supplied URLs', async () => {
    const updates = createUpdates();
    for (const [raw, isTrusted] of [
      [{ kind: 'check' }, false],
      [{ kind: 'download', url: 'https://evil.test' }, true],
      [{ kind: 'install' }, true],
    ] satisfies [unknown, boolean][]) {
      expect((await runAppUpdateCommand(updates.controller, raw, isTrusted)).kind).toBe('failed');
    }
    expect(updates.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updates.updater.downloadUpdate).not.toHaveBeenCalled();
    expect((await runAppUpdateCommand(updates.controller, { kind: 'status' }, true)).kind).toBe(
      'ok',
    );
    await runAppUpdateCommand(updates.controller, { kind: 'check' }, true);
    await runAppUpdateCommand(updates.controller, { kind: 'download' }, true);
    expect((await runAppUpdateCommand(updates.controller, { kind: 'restart' }, true)).kind).toBe(
      'ok',
    );
  });
});
