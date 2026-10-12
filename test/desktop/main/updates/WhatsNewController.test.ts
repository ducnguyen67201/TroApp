import { describe, expect, it, vi } from 'vitest';
import { WhatsNewCommand } from '#contracts/WhatsNew.js';
import {
  appReleaseNotes,
  type AppReleaseNotes,
} from '../../../../src/desktop/updates/ReleaseNotes.js';
import { WhatsNewController } from '../../../../src/desktop/main/updates/WhatsNewController.js';
import type {
  SavedWhatsNewPreferences,
  WhatsNewStore,
} from '../../../../src/desktop/main/updates/WhatsNewPreferences.js';

const firstRelease = appReleaseNotes[0];
if (!firstRelease) {
  throw new Error('Missing release content');
}
const secondRelease: AppReleaseNotes = { ...firstRelease, id: '0.2.0', version: '0.2.0' };
const thirdRelease: AppReleaseNotes = { ...firstRelease, id: '0.3.0', version: '0.3.0' };
const releases = [thirdRelease, secondRelease, firstRelease];
const read = { kind: WhatsNewCommand.READ };
const markSeen = { kind: WhatsNewCommand.MARK_SEEN };

function createStore(saved: SavedWhatsNewPreferences | null = null) {
  let preferences = saved;
  return {
    readPreferences: vi
      .fn<WhatsNewStore['readPreferences']>()
      .mockImplementation(() => Promise.resolve(preferences)),
    savePreferences: vi.fn<WhatsNewStore['savePreferences']>().mockImplementation((value) => {
      preferences = { ...value };
      return Promise.resolve();
    }),
  } satisfies WhatsNewStore;
}

function savedVersion(version: string): SavedWhatsNewPreferences {
  return {
    schemaVersion: 1,
    lastRunVersion: version,
    lastSeenWhatsNewReleaseId: version,
    pendingReleaseId: null,
  };
}

describe('release presentation lifecycle', () => {
  it('establishes a baseline on first launch and permits a manual view without automatic display', async () => {
    const store = createStore();
    const controller = new WhatsNewController(store, '0.1.0', releases);
    expect(await controller.execute(read, true)).toMatchObject({
      kind: 'ok',
      status: { releaseId: '0.1.0', hasUnseenRelease: true, shouldAutoShow: false },
    });
    expect(await controller.execute(markSeen, true)).toMatchObject({
      kind: 'ok',
      status: { hasUnseenRelease: false, shouldAutoShow: false },
    });
    const restarted = new WhatsNewController(store, '0.1.0', releases);
    expect(await restarted.execute(read, true)).toMatchObject({
      status: { hasUnseenRelease: false, shouldAutoShow: false },
    });
  });

  it('shows only the installed release after skipped updates and persists seen state across restarts', async () => {
    const store = createStore(savedVersion('0.1.0'));
    const controller = new WhatsNewController(store, '0.3.0', releases);
    expect(await controller.execute(read, true)).toMatchObject({
      status: { releaseId: '0.3.0', shouldAutoShow: true, hasUnseenRelease: true },
    });
    // Startup may be interrupted before a signed-in, idle window can present it.
    const resumed = new WhatsNewController(store, '0.3.0', releases);
    expect(await resumed.execute(read, true)).toMatchObject({ status: { shouldAutoShow: true } });
    await resumed.execute(markSeen, true);
    const restarted = new WhatsNewController(store, '0.3.0', releases);
    expect(await restarted.execute(read, true)).toMatchObject({
      status: { shouldAutoShow: false, hasUnseenRelease: false },
    });
    expect(await restarted.execute(markSeen, true)).toMatchObject({
      status: { shouldAutoShow: false },
    });
  });

  it('retains replayable earlier notes for a patch without new highlights and never pops up on downgrade', async () => {
    const store = createStore(savedVersion('0.2.0'));
    const patched = new WhatsNewController(store, '0.2.1', releases);
    expect(await patched.execute(read, true)).toMatchObject({
      status: { releaseId: '0.2.0', shouldAutoShow: false, hasUnseenRelease: false },
    });
    const downgraded = new WhatsNewController(store, '0.1.0', releases);
    expect(await downgraded.execute(read, true)).toMatchObject({
      status: { releaseId: '0.1.0', shouldAutoShow: false },
    });
  });

  it('shows newly introduced highlights when updating directly to a later patch', async () => {
    const store = createStore(savedVersion('0.1.0'));
    const controller = new WhatsNewController(store, '0.2.1', releases);
    expect(await controller.execute(read, true)).toMatchObject({
      status: { releaseId: '0.2.0', shouldAutoShow: true },
    });
  });

  it('excludes future releases, empty highlights and unsupported prerelease versions', async () => {
    const store = createStore(savedVersion('0.1.0'));
    const emptyRelease = { ...secondRelease, highlights: [] };
    const controller = new WhatsNewController(store, '0.2.0', [
      thirdRelease,
      emptyRelease,
      firstRelease,
    ]);
    expect(await controller.execute(read, true)).toMatchObject({
      status: { releaseId: '0.1.0', shouldAutoShow: false },
    });
    const prerelease = new WhatsNewController(store, '0.3.0-beta.1', releases);
    expect(await prerelease.execute(read, true)).toMatchObject({
      status: { releaseId: null, shouldAutoShow: false },
    });
  });

  it('rejects untrusted callers and arbitrary renderer paths or release IDs without touching storage', async () => {
    const store = createStore();
    const controller = new WhatsNewController(store, '0.2.0', releases);
    expect(await controller.execute(markSeen, false)).toEqual({
      kind: 'failed',
      reason: 'unavailable',
    });
    expect(await controller.execute({ ...markSeen, releaseId: '/private/file' }, true)).toEqual({
      kind: 'failed',
      reason: 'unavailable',
    });
    expect(store.readPreferences).not.toHaveBeenCalled();
    expect(store.savePreferences).not.toHaveBeenCalled();
  });

  it('preserves unreadable preferences and keeps manual notes available with bounded diagnostics', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = createStore();
      store.readPreferences.mockRejectedValue(new Error('private raw configuration'));
      const controller = new WhatsNewController(store, '0.2.0', releases);
      expect(await controller.execute(read, true)).toMatchObject({
        status: { releaseId: '0.2.0', shouldAutoShow: false },
      });
      expect(await controller.execute(markSeen, true)).toEqual({
        kind: 'failed',
        reason: 'unavailable',
      });
      expect(store.savePreferences).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([
        ['whats-new.preferences.failed', { stage: 'load' }],
        ['whats-new.preferences.failed', { stage: 'mark-seen' }],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
