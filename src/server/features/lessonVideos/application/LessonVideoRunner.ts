import {
  LessonVideoStatus,
  LessonVideoFailure,
  LessonVideoStage,
} from '#contracts/LessonVideos.js';
import type { LessonVideoStore, LessonDiagnostics } from './LessonVideoPorts.js';
import type { RunLessonVideoStage } from './RunLessonVideoStage.js';

/** One local wake loop; durable leases and attempts make process restarts safe. */
export class LessonVideoRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly store: LessonVideoStore,
    private readonly stages: RunLessonVideoStage,
    private readonly newId: () => string,
    private readonly report: LessonDiagnostics,
  ) {}
  start(pollMs: number): void {
    this.timer = setInterval(() => {
      this.wake();
    }, pollMs);
    this.timer.unref();
    this.wake();
  }
  wake(): void {
    if (this.running || this.shutdown.signal.aborted) {
      return;
    }
    this.running = this.runNext()
      .catch(() => {
        this.report({
          lessonId: 'unclaimed',
          revision: 0,
          stage: LessonVideoStage.CONTENT,
          state: 'checkpoint-unavailable',
        });
      })
      .finally(() => {
        this.running = null;
      });
  }
  private async runNext(): Promise<void> {
    const claimId = this.newId();
    let lesson = await this.store.claimNextLesson(new Date(), claimId);
    if (!lesson) {
      return;
    }
    if (Date.parse(lesson.deadline) <= Date.now()) {
      await this.store.saveStageResult({
        ...lesson,
        status: LessonVideoStatus.STOPPED,
        claimId: null,
        error: LessonVideoFailure.DEADLINE,
      });
      return;
    }
    const id = lesson.id;
    const settings = lesson.settings;
    const claim = new AbortController();
    const signal = AbortSignal.any([
      this.shutdown.signal,
      claim.signal,
      AbortSignal.timeout(Math.max(1, Date.parse(lesson.deadline) - Date.now())),
    ]);
    const heartbeat = setInterval(() => {
      void this.store.renewClaim(id, claimId, new Date(Date.now() + settings.jobs.leaseMs)).then(
        (renewed) => {
          if (!renewed) {
            claim.abort();
          }
        },
        () => {
          claim.abort();
        },
      );
    }, settings.jobs.heartbeatMs);
    try {
      while (lesson.status === LessonVideoStatus.RUNNING && !signal.aborted) {
        lesson = await this.stages.execute(lesson, signal);
        this.report({
          lessonId: lesson.id,
          revision: lesson.revision,
          stage: lesson.stage,
          state: lesson.status,
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (!this.shutdown.signal.aborted && !claim.signal.aborted && signal.aborted) {
        const current = await this.store.read(id);
        if (current?.claimId === claimId) {
          await this.store.saveStageResult({
            ...current,
            status: LessonVideoStatus.STOPPED,
            claimId: null,
            error: LessonVideoFailure.DEADLINE,
          });
        }
      }
    }
  }
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.shutdown.abort();
    await this.running;
  }
}
