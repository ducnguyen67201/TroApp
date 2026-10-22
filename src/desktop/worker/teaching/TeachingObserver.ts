import {
  TeachingObservationKind,
  TeachingObservationSchema,
  type TeachingObservation,
  type TeachingObservationInput,
} from '#contracts/TeachingObservation.js';

export type TeachingObserver = (event: TeachingObservation) => void;

/** Optional task-local observation. A slow sink must enqueue its own writes.
 * Validation and sink failures cannot change tutoring or expose arbitrary SDK data. */
export class TeachingObservationRecorder {
  private readonly startedAt: number;
  private sequence = 0;
  private elapsedMs = 0;
  private failedEvents = 0;
  private ended = false;

  constructor(
    private readonly observe?: TeachingObserver,
    private readonly readTime: () => number = () => performance.now(),
  ) {
    this.startedAt = this.readTime();
  }

  record(lessonId: string, input: TeachingObservationInput): void {
    if (this.ended) {
      return;
    }
    this.emit(lessonId, input);
  }

  /** Close once after teardown. Counts describe preceding attempts, excluding this terminal event.
   * A missing terminal or nonzero failedEvents makes an evaluation trace incomplete. */
  finish(lessonId: string): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.emit(lessonId, {
      kind: TeachingObservationKind.TRACE_ENDED,
      attemptedEvents: this.sequence,
      failedEvents: this.failedEvents,
    });
  }

  readStatus(): { attemptedEvents: number; failedEvents: number } {
    return { attemptedEvents: this.sequence, failedEvents: this.failedEvents };
  }

  private emit(lessonId: string, input: TeachingObservationInput): void {
    if (!this.observe) {
      return;
    }
    this.sequence += 1;
    try {
      this.elapsedMs = Math.max(this.elapsedMs, this.readTime() - this.startedAt);
      const event = TeachingObservationSchema.safeParse({
        ...input,
        sequence: this.sequence,
        elapsedMs: this.elapsedMs,
        lessonId,
      });
      if (!event.success) {
        this.failedEvents += 1;
        return;
      }
      this.observe(event.data);
    } catch {
      this.failedEvents += 1;
    }
  }
}
