import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClassroomInsightRetentionRunner,
  type ClassroomInsightRetentionStore,
} from '../../../../src/server/features/classroom/infrastructure/ClassroomInsightRetentionRunner.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('classroom insight retention lifecycle', () => {
  it('drains bounded batches and schedules remaining work before the hourly idle period', async () => {
    vi.useFakeTimers();
    const purge = vi
      .fn<ClassroomInsightRetentionStore['purgeExpiredSources']>()
      .mockResolvedValue({ expired: 0, more: false });
    for (let index = 0; index < 20; index += 1) {
      purge.mockResolvedValueOnce({ expired: 200, more: true });
    }
    const now = new Date('2026-10-31T00:00:00Z');
    const runner = new ClassroomInsightRetentionRunner(
      { purgeExpiredSources: purge },
      180,
      vi.fn(),
      () => now,
    );
    await runner.start();
    expect(purge).toHaveBeenCalledTimes(20);
    expect(purge).toHaveBeenCalledWith(now, 180);
    await vi.advanceTimersByTimeAsync(1000);
    expect(purge).toHaveBeenCalledTimes(21);
    await runner.close();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(purge).toHaveBeenCalledTimes(21);
  });

  it('resumes stored retention policies when current capture configuration has no duration', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-10-31T00:00:00Z');
    const purge = vi
      .fn<ClassroomInsightRetentionStore['purgeExpiredSources']>()
      .mockResolvedValueOnce({ expired: 4, more: false })
      .mockResolvedValue({ expired: 0, more: false });
    const reportFailure = vi.fn<() => void>();
    const runner = new ClassroomInsightRetentionRunner(
      { purgeExpiredSources: purge },
      undefined,
      reportFailure,
      () => now,
    );
    await runner.start();
    expect(purge).toHaveBeenCalledWith(now, undefined);
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3600000);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(reportFailure).not.toHaveBeenCalled();
    await runner.close();
  });

  it('waits for an active transaction at shutdown without scheduling another purge', async () => {
    vi.useFakeTimers();
    let finishPurge: ((value: { expired: number; more: boolean }) => void) | undefined;
    const purge = vi.fn<ClassroomInsightRetentionStore['purgeExpiredSources']>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPurge = resolve;
        }),
    );
    const runner = new ClassroomInsightRetentionRunner({ purgeExpiredSources: purge }, 30, vi.fn());
    const startup = runner.start();
    let closed = false;
    const closing = runner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    if (!finishPurge) {
      throw new Error('Fixture purge not started');
    }
    finishPurge({ expired: 1, more: true });
    await startup;
    await closing;
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(3600000);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('refuses initial startup after a purge failure and reports a bounded failure', async () => {
    vi.useFakeTimers();
    const purge = vi
      .fn<ClassroomInsightRetentionStore['purgeExpiredSources']>()
      .mockRejectedValue(new Error('Unavailable'));
    const reportFailure = vi.fn<() => void>();
    const runner = new ClassroomInsightRetentionRunner(
      { purgeExpiredSources: purge },
      30,
      reportFailure,
    );
    await expect(runner.start()).rejects.toThrow('Unavailable');
    expect(reportFailure).toHaveBeenCalledTimes(1);
    await runner.close();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
