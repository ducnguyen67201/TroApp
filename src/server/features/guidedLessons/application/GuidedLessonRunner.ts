import type { GuidedLessonService } from './GuidedLessonService.js';

/** PostgreSQL owns jobs; this bounded in-process scheduler wakes one stage at a time. */
export class GuidedLessonRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly service: GuidedLessonService,
    private readonly reportError: () => void,
  ) {}

  start(): void {
    this.closed = false;
    this.timer ??= setInterval(() => {
      this.wake();
    }, 1000);
    this.timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.closed || this.running) {
      return;
    }
    this.running = this.service
      .prepareNextLesson()
      .catch(this.reportError)
      .finally(() => {
        this.running = null;
      });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.service.close();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.running;
  }
}
