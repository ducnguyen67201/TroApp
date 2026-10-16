import { AgentWorkerPolicy } from './AgentWorkerPolicy.js';

export interface AgentLifecycleClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface AgentWorkLease {
  isCurrent(): boolean;
  release(): void;
}

const systemClock: AgentLifecycleClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Holds a worker during admission/capture/lessons. Timers cannot outlive their generation. */
export class AgentWorkerLifecycle {
  private generation = 0;
  private leases = 0;
  private taskDeadline: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private timerRevision = 0;

  constructor(
    private readonly stop: () => void,
    private readonly clock = systemClock,
  ) {}

  acquireWork(isTask: boolean): AgentWorkLease {
    this.clearTimer();
    const generation = this.generation;
    this.leases += 1;
    let released = false;
    return {
      isCurrent: () => !released && generation === this.generation,
      release: () => {
        if (released || generation !== this.generation) {
          return;
        }
        released = true;
        this.leases -= 1;
        if (isTask) {
          this.taskDeadline = this.clock.now() + AgentWorkerPolicy.IDLE_MS;
        }
        if (this.leases !== 0) {
          return;
        }
        const deadline =
          this.taskDeadline ?? this.clock.now() + AgentWorkerPolicy.SPECULATIVE_IDLE_MS;
        const revision = ++this.timerRevision;
        this.cancelTimer = this.clock.schedule(
          () => {
            if (
              generation !== this.generation ||
              revision !== this.timerRevision ||
              this.leases !== 0
            ) {
              return;
            }
            this.cancelTimer = null;
            this.taskDeadline = null;
            this.stop();
          },
          Math.max(0, deadline - this.clock.now()),
        );
      },
    };
  }

  invalidate(): void {
    this.generation += 1;
    this.leases = 0;
    this.taskDeadline = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    this.timerRevision += 1;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
}
