import { describe, expect, it, vi } from 'vitest';
import {
  AgentWorkerLifecycle,
  type AgentLifecycleClock,
} from '../../../../src/desktop/main/agent/AgentWorkerLifecycle.js';

function createHarness() {
  let now = 0;
  const timers: {
    callback: () => void;
    delay: number;
    cancel: ReturnType<typeof vi.fn<() => void>>;
  }[] = [];
  const clock: AgentLifecycleClock = {
    now: () => now,
    schedule: (callback, delay) => {
      const cancel = vi.fn<() => void>();
      timers.push({ callback, delay, cancel });
      return cancel;
    },
  };
  const stop = vi.fn<() => void>();
  const lifecycle = new AgentWorkerLifecycle(stop, clock);
  return {
    lifecycle,
    timers,
    stop,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('agent worker work leases', () => {
  it('keeps a lesson alive indefinitely and stops 120 seconds after settlement', () => {
    const { lifecycle, timers, stop, advance } = createHarness();
    const task = lifecycle.acquireWork(true);
    advance(600_000);
    expect(timers).toHaveLength(0);
    task.release();
    expect(timers.at(-1)?.delay).toBe(120_000);
    timers.at(-1)?.callback();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('retains canceled speculative work for 15 seconds and releases idempotently', () => {
    const { lifecycle, timers } = createHarness();
    const capture = lifecycle.acquireWork(false);
    capture.release();
    capture.release();
    expect(capture.isCurrent()).toBe(false);
    expect(timers).toHaveLength(1);
    expect(timers.at(-1)?.delay).toBe(15_000);
  });

  it('does not extend real task retention for an abandoned capture', () => {
    const { lifecycle, timers, advance } = createHarness();
    lifecycle.acquireWork(true).release();
    advance(119_000);
    const capture = lifecycle.acquireWork(false);
    advance(2000);
    capture.release();
    expect(timers.at(-1)?.delay).toBe(0);
  });

  it('fences a queued idle callback when a new task arrives at the deadline', () => {
    const { lifecycle, timers, stop } = createHarness();
    lifecycle.acquireWork(true).release();
    const expired = timers.at(-1);
    const next = lifecycle.acquireWork(true);
    expired?.callback();
    expect(stop).not.toHaveBeenCalled();
    expect(expired?.cancel).toHaveBeenCalledOnce();
    next.release();
    timers.at(-1)?.callback();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('fences old leases and timers across account changes', () => {
    const { lifecycle, timers, stop } = createHarness();
    lifecycle.acquireWork(true).release();
    const old = timers.at(-1);
    const capture = lifecycle.acquireWork(false);
    lifecycle.invalidate();
    const current = lifecycle.acquireWork(true);
    capture.release();
    old?.callback();
    expect(capture.isCurrent()).toBe(false);
    expect(current.isCurrent()).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
  });

  it('does not sleep between overlapping capture and task leases', () => {
    const { lifecycle, timers } = createHarness();
    const capture = lifecycle.acquireWork(false);
    const task = lifecycle.acquireWork(true);
    task.release();
    expect(timers).toHaveLength(0);
    capture.release();
    expect(timers.at(-1)?.delay).toBe(120_000);
  });
});
