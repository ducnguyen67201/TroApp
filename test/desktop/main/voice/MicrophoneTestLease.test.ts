import { describe, expect, it, vi } from 'vitest';
import {
  MicrophoneCaptureMode,
  MicrophoneTestCommandSchema,
  microphoneTestLeaseMs,
  type MicrophoneTestEvent,
} from '#contracts/MicrophoneTest.js';
import { MicrophoneTestLease } from '../../../../src/desktop/main/voice/MicrophoneTestLease.js';

function createLease() {
  let expire: (() => void) | undefined;
  const cancelTimer = vi.fn<() => void>();
  const dependencies = {
    canStart: vi.fn<() => boolean>().mockReturnValue(true),
    requestAccess: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    schedule: vi
      .fn<(callback: () => void, delayMs: number) => () => void>()
      .mockImplementation((callback) => {
        expire = callback;
        return cancelTimer;
      }),
    emit: vi.fn<(event: MicrophoneTestEvent) => void>(),
  };
  return {
    lease: new MicrophoneTestLease(dependencies),
    dependencies,
    cancelTimer,
    expire: () => expire?.(),
  };
}

const testId = '33333333-3333-4333-8333-333333333333';

const otherId = '44444444-4444-4444-8444-444444444444';

describe('exclusive local microphone test lease', () => {
  it('renews authorized previews without requesting access again and fences the old expiry', async () => {
    const { lease, dependencies, cancelTimer, expire } = createLease();
    expect(await lease.startTest(testId, MicrophoneCaptureMode.PREVIEW)).toEqual({ kind: 'ok' });
    const originalExpiry = dependencies.schedule.mock.calls[0]?.[0];
    expect(lease.renewTest(testId)).toEqual({ kind: 'ok' });
    expect(cancelTimer).toHaveBeenCalledOnce();
    expect(dependencies.schedule).toHaveBeenCalledTimes(2);
    expect(dependencies.schedule).toHaveBeenLastCalledWith(
      expect.any(Function),
      microphoneTestLeaseMs,
    );
    expect(dependencies.requestAccess).toHaveBeenCalledOnce();
    originalExpiry?.();
    expect(lease.isAuthorized()).toBe(true);
    expect(dependencies.emit).not.toHaveBeenCalled();
    expect(await lease.startTest(otherId)).toEqual({ kind: 'failed' });
    expire();
    expect(lease.isActive()).toBe(false);
    expect(dependencies.emit).toHaveBeenCalledExactlyOnceWith({ kind: 'canceled', testId });
    expect(lease.renewTest(testId)).toEqual({ kind: 'failed' });
  });

  it('rejects renewal for tests, another reservation or a busy voice/task state', async () => {
    const { lease, dependencies } = createLease();
    expect(lease.renewTest(testId)).toEqual({ kind: 'failed' });
    await lease.startTest(testId);
    expect(lease.renewTest(testId)).toEqual({ kind: 'failed' });
    expect(dependencies.schedule).toHaveBeenCalledOnce();
    lease.stopTest(testId);
    await lease.startTest(testId, MicrophoneCaptureMode.PREVIEW);
    expect(lease.renewTest(otherId)).toEqual({ kind: 'failed' });
    dependencies.canStart.mockReturnValue(false);
    expect(lease.renewTest(testId)).toEqual({ kind: 'failed' });
    expect(dependencies.schedule).toHaveBeenCalledTimes(2);
  });

  it('does not renew previews while permission is pending', async () => {
    const { lease, dependencies } = createLease();
    let grant: ((isAllowed: boolean) => void) | undefined;
    dependencies.requestAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const pending = lease.startTest(testId, MicrophoneCaptureMode.PREVIEW);
    expect(lease.renewTest(testId)).toEqual({ kind: 'failed' });
    expect(dependencies.schedule).toHaveBeenCalledOnce();
    grant?.(true);
    expect(await pending).toEqual({ kind: 'ok' });
    expect(lease.renewTest(testId)).toEqual({ kind: 'ok' });
    expect(dependencies.schedule).toHaveBeenCalledTimes(2);
  });

  it('fences a stopped reservation expiry even when its ID is reused', async () => {
    const { lease, dependencies, expire } = createLease();
    await lease.startTest(testId, MicrophoneCaptureMode.PREVIEW);
    const originalExpiry = dependencies.schedule.mock.calls[0]?.[0];
    lease.stopTest(testId);
    await lease.startTest(testId, MicrophoneCaptureMode.PREVIEW);
    originalExpiry?.();
    expect(lease.isAuthorized()).toBe(true);
    expect(dependencies.emit).not.toHaveBeenCalled();
    expire();
    expect(lease.isActive()).toBe(false);
    expect(dependencies.emit).toHaveBeenCalledExactlyOnceWith({ kind: 'canceled', testId });
  });

  it('blocks concurrent tests and rejects stop commands for a different test', async () => {
    const { lease, dependencies, cancelTimer } = createLease();
    expect(await lease.startTest(testId)).toEqual({ kind: 'ok' });
    expect(lease.isAuthorized()).toBe(true);
    expect(dependencies.schedule).toHaveBeenCalledWith(expect.any(Function), microphoneTestLeaseMs);
    expect(await lease.startTest(otherId)).toEqual({ kind: 'failed' });
    expect(lease.stopTest(otherId)).toEqual({ kind: 'failed' });
    expect(lease.isActive()).toBe(true);
    expect(lease.stopTest(testId)).toEqual({ kind: 'ok' });
    expect(cancelTimer).toHaveBeenCalledOnce();
    expect(lease.isAuthorized()).toBe(false);
  });

  it('reserves pending access without granting permission and fences canceled authorization', async () => {
    const { lease, dependencies } = createLease();
    let grant: ((isAllowed: boolean) => void) | undefined;
    dependencies.requestAccess.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const pending = lease.startTest(testId);
    expect(lease.isActive()).toBe(true);
    expect(lease.isAuthorized()).toBe(false);
    lease.cancelTest();
    // A replayed ID cannot let the old grant mutate a new reservation.
    expect(await lease.startTest(testId)).toEqual({ kind: 'ok' });
    grant?.(true);
    expect(await pending).toEqual({ kind: 'failed' });
    expect(lease.isAuthorized()).toBe(true);
    lease.cancelTest();
    expect(dependencies.emit).toHaveBeenCalledWith({ kind: 'canceled', testId });
  });

  it('releases access on expiry and authorization failure', async () => {
    const { lease, dependencies, expire } = createLease();
    await lease.startTest(testId);
    expire();
    expect(lease.isActive()).toBe(false);
    expect(dependencies.emit).toHaveBeenCalledOnce();
    dependencies.requestAccess.mockResolvedValueOnce(false);
    expect(await lease.startTest(otherId)).toEqual({ kind: 'failed' });
    expect(lease.isAuthorized()).toBe(false);
    dependencies.requestAccess.mockRejectedValueOnce(new Error('Unavailable'));
    expect(await lease.startTest(testId)).toEqual({ kind: 'failed' });
    expect(lease.isActive()).toBe(false);
  });

  it('rejects busy voice/task state before and after authorization', async () => {
    const { lease, dependencies } = createLease();
    dependencies.canStart.mockReturnValueOnce(false);
    expect(await lease.startTest(testId)).toEqual({ kind: 'failed' });
    expect(dependencies.requestAccess).not.toHaveBeenCalled();
    dependencies.canStart.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await lease.startTest(testId)).toEqual({ kind: 'failed' });
    expect(lease.isActive()).toBe(false);
  });

  it('validates narrow commands without permitting device paths, audio or extra fields', () => {
    expect(MicrophoneTestCommandSchema.safeParse({ kind: 'start', testId }).success).toBe(true);
    for (const mode of Object.values(MicrophoneCaptureMode)) {
      expect(MicrophoneTestCommandSchema.safeParse({ kind: 'start', testId, mode }).success).toBe(
        true,
      );
    }
    expect(MicrophoneTestCommandSchema.safeParse({ kind: 'renew', testId }).success).toBe(true);
    expect(
      MicrophoneTestCommandSchema.safeParse({ kind: 'start', testId, mode: 'unbounded' }).success,
    ).toBe(false);
    expect(
      MicrophoneTestCommandSchema.safeParse({
        kind: 'renew',
        testId,
        mode: MicrophoneCaptureMode.PREVIEW,
      }).success,
    ).toBe(false);
    expect(MicrophoneTestCommandSchema.safeParse({ kind: 'renew', testId, pcm: [] }).success).toBe(
      false,
    );
    expect(MicrophoneTestCommandSchema.safeParse({ kind: 'start', testId, pcm: [] }).success).toBe(
      false,
    );
    expect(
      MicrophoneTestCommandSchema.safeParse({ kind: 'start', testId: 'arbitrary' }).success,
    ).toBe(false);
  });
});
