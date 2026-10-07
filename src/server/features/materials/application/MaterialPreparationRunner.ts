import type { MaterialService } from './MaterialService.js';

/** Durable rows own state; this bounded local runner only wakes the next job. */
export class MaterialPreparationRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(
    private readonly service: MaterialService,
    private readonly reportError: () => void,
  ) {}
  start(): void {
    this.timer ??= setInterval(() => {
      this.wake();
    }, 2000);
    this.timer.unref();
    this.wake();
  }
  wake(): void {
    if (this.running) {
      return;
    }
    this.running = this.service
      .prepareNextCollection()
      .then(() => {})
      .catch(this.reportError)
      .finally(() => {
        this.running = null;
      });
  }
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.running;
  }
}
