import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentProgressPhase,
  CompanionHudPhase,
  type CompanionHudSnapshot,
} from '#contracts/CompanionHud.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  DesktopCompanion,
  type CompanionAccessPort,
  type CompanionPresentationPort,
  type DesktopCompanionCursor,
} from './DesktopCompanion.js';

const captureId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

function createHarness() {
  vi.useFakeTimers();
  const snapshots: CompanionHudSnapshot[] = [];
  const cursor = {
    startFollowing: vi.fn<DesktopCompanionCursor['startFollowing']>().mockResolvedValue({
      kind: 'started',
      sessionId,
    }),
  } satisfies DesktopCompanionCursor;
  const access = {
    canShow: vi.fn<CompanionAccessPort['canShow']>().mockResolvedValue(true),
  } satisfies CompanionAccessPort;
  const presentation = {
    start: vi.fn<CompanionPresentationPort['start']>().mockResolvedValue(undefined),
    dispose: vi.fn<CompanionPresentationPort['dispose']>(),
    showSnapshot: (snapshot: CompanionHudSnapshot) => {
      snapshots.push(snapshot);
    },
  } satisfies CompanionPresentationPort;
  const companion = new DesktopCompanion(cursor, access, presentation, {
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
  });
  return { companion, cursor, access, presentation, snapshots, latest: () => snapshots.at(-1) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop companion composition', () => {
  it('waits for native HUD registration before starting the cursor without resetting an active capture', async () => {
    const { companion, cursor, presentation, latest } = createHarness();
    let finishConnection = (): void => {};
    presentation.start.mockReturnValue(
      new Promise<void>((resolve) => {
        finishConnection = resolve;
      }),
    );
    companion.hud.receiveVoiceEvent({ kind: 'prepare', captureId });
    companion.hud.updateMeter({ captureId, sequence: 0, level: 0.7 });
    const following = companion.startFollowing();
    await Promise.resolve();
    expect(presentation.start).toHaveBeenCalledTimes(1);
    expect(cursor.startFollowing).not.toHaveBeenCalled();
    expect(latest()?.phase).toBe(CompanionHudPhase.LISTENING);
    finishConnection();
    expect(await following).toEqual({ kind: 'started', sessionId });
    expect(cursor.startFollowing).toHaveBeenCalledTimes(1);
    expect(latest()?.level).toBe(0.7);
  });

  it('skips native presentation when access is unavailable and preserves cursor authorization errors', async () => {
    const { companion, cursor, access, presentation } = createHarness();
    access.canShow.mockResolvedValue(false);
    cursor.startFollowing.mockResolvedValue({ kind: 'failed', message: 'Sign in to use Tro.' });
    expect(await companion.startFollowing()).toEqual({
      kind: 'failed',
      message: 'Sign in to use Tro.',
    });
    expect(presentation.start).not.toHaveBeenCalled();
  });

  it('keeps cursor startup and voice state usable if optional presentation fails', async () => {
    const { companion, presentation, latest } = createHarness();
    presentation.start.mockRejectedValue(new Error('Presentation unavailable'));
    expect(await companion.startFollowing()).toEqual({ kind: 'started', sessionId });
    companion.hud.receiveVoiceEvent({ kind: 'prepare', captureId });
    companion.hud.receiveVoiceEvent({ kind: 'release', captureId });
    expect(latest()?.phase).toBe(CompanionHudPhase.TRANSCRIBING);
  });

  it('does not resurrect presentation or following after disposal during access checks', async () => {
    const { companion, access, cursor, presentation } = createHarness();
    let finishAccess: (allowed: boolean) => void = () => {};
    access.canShow.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishAccess = resolve;
      }),
    );
    const following = companion.startFollowing();
    companion.dispose();
    finishAccess(true);
    expect(await following).toEqual({ kind: 'stopped' });
    expect(presentation.start).not.toHaveBeenCalled();
    expect(cursor.startFollowing).not.toHaveBeenCalled();
  });

  it('fences cursor handoff and old HUD results on close, then supports an authorized restart', async () => {
    const { companion, cursor, presentation, latest, snapshots } = createHarness();
    let finishConnection = (): void => {};
    presentation.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishConnection = resolve;
      }),
    );
    const following = companion.startFollowing();
    await Promise.resolve();
    companion.hud.startTask(sessionId, DesktopLocale.ENGLISH);
    companion.hud.finishTask({ kind: 'completed', answer: 'Done' }, sessionId);
    companion.dispose();
    const snapshotsAfterClose = snapshots.length;
    finishConnection();
    expect(await following).toEqual({ kind: 'stopped' });
    companion.hud.finishTask({ kind: 'completed', answer: 'Late result' }, sessionId);
    companion.hud.receiveProgress({
      kind: 'progress',
      requestId: captureId,
      sessionId,
      phase: AgentProgressPhase.THINKING,
    });
    vi.advanceTimersByTime(2000);
    expect(snapshots).toHaveLength(snapshotsAfterClose);
    expect(latest()?.phase).toBe(CompanionHudPhase.IDLE);
    expect(presentation.dispose).toHaveBeenCalledTimes(1);
    expect(cursor.startFollowing).not.toHaveBeenCalled();
    expect(await companion.startFollowing()).toEqual({ kind: 'started', sessionId });
    expect(cursor.startFollowing).toHaveBeenCalledTimes(1);
  });
});
