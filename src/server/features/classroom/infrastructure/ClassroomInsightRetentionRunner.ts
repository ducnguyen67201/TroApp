export interface ClassroomInsightRetentionStore {
  purgeExpiredSources(
    now: Date,
    retentionDays?: number,
  ): Promise<{ expired: number; more: boolean }>;
}

const RetentionSchedule = { INTERVAL_MS: 3600000, CONTINUATION_MS: 1000, MAX_BATCHES: 20 } as const;

/** Drain bounded source batches without overlapping work; close waits for the active purge. */
export class ClassroomInsightRetentionRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly store: ClassroomInsightRetentionStore,
    private readonly retentionDays: number | undefined,
    private readonly reportFailure: () => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Initial retention failure prevents startup while previously approved policies remain enforceable. */
  async start(): Promise<void> {
    await this.wake(true);
  }

  private async purgeBatches(): Promise<boolean> {
    let more = false;
    for (let batch = 0; batch < RetentionSchedule.MAX_BATCHES && !this.stopped; batch += 1) {
      const result = await this.store.purgeExpiredSources(this.now(), this.retentionDays);
      more = result.more;
      if (!more) {
        break;
      }
    }
    return more;
  }

  private wake(isStartup = false): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.running) {
      return this.running;
    }
    this.running = this.purgeBatches()
      .then((more) => {
        this.schedule(more ? RetentionSchedule.CONTINUATION_MS : RetentionSchedule.INTERVAL_MS);
      })
      .catch((error: unknown) => {
        this.reportFailure();
        if (isStartup) {
          throw error;
        }
        this.schedule(RetentionSchedule.INTERVAL_MS);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.wake();
    }, delayMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.running;
  }
}
