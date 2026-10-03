import type { DesktopObservation } from '#contracts/DesktopObservation.js';

export const TeachingObservationLimits = {
  POLL_MS: 250,
  OBSERVATION_READY_MS: 10000,
  QUIET_MS: 500,
  NO_PROGRESS_COOLDOWN_MS: 5000,
  MAXIMUM_COOLDOWN_MS: 60000,
  MODEL_STEP_MS: 45000,
  MAXIMUM_MODEL_TURNS: 8,
  MAXIMUM_RUNS_PER_MINUTE: 12,
} as const;

export const TeachingWakeReason = {
  INPUT: 'settled_student_input',
  PENDING: 'input_linked_pending_result',
} as const;

/** Pure scheduling policy. Revisions request observation; they never prove progress. */
export class TeachingObservationPolicy {
  private capturedRevision: number | null = null;
  private pending = false;
  private activityRevision: number | null = null;
  private followups = 0;
  private nextFollowupAtMs = Number.POSITIVE_INFINITY;
  private admissions: number[] = [];

  constructor(private readonly readTime: () => number = () => performance.now()) {}

  recordCapturedInput(revision: number): void {
    if (
      this.capturedRevision !== null &&
      this.capturedRevision !== revision &&
      this.activityRevision !== revision
    ) {
      this.activityRevision = revision;
      this.followups = 0;
      this.nextFollowupAtMs = Number.POSITIVE_INFINITY;
    }
    this.capturedRevision = revision;
  }

  recordAssessment(hasProgress: boolean): void {
    this.pending = !hasProgress;
    if (hasProgress) {
      this.nextFollowupAtMs = Number.POSITIVE_INFINITY;
    } else if (
      this.activityRevision !== null &&
      this.followups < 2 &&
      this.nextFollowupAtMs === Number.POSITIVE_INFINITY
    ) {
      this.nextFollowupAtMs = this.readTime() + 1000;
    }
  }

  admitRun(): boolean {
    const nowMs = this.readTime();
    this.admissions = this.admissions.filter((time) => nowMs - time < 60000);
    if (this.admissions.length >= TeachingObservationLimits.MAXIMUM_RUNS_PER_MINUTE) {
      return false;
    }
    this.admissions.push(nowMs);

    return true;
  }

  canObserve(baseline: DesktopObservation, current: DesktopObservation): boolean {
    if (
      !current.ready ||
      current.buttons_down ||
      current.quiet_ms < TeachingObservationLimits.QUIET_MS
    ) {
      return false;
    }
    if (current.input_revision !== baseline.input_revision) {
      this.activityRevision = current.input_revision;
      this.followups = 0;
      this.nextFollowupAtMs = Number.POSITIVE_INFINITY;
      return true;
    }
    if (
      this.pending &&
      this.activityRevision === baseline.input_revision &&
      this.followups < 2 &&
      this.readTime() >= this.nextFollowupAtMs
    ) {
      this.followups += 1;
      this.nextFollowupAtMs =
        this.followups < 2 ? this.readTime() + 2000 : Number.POSITIVE_INFINITY;
      return true;
    }
    return false;
  }

  readWakeReason(
    baseline: DesktopObservation,
    current: DesktopObservation,
  ): (typeof TeachingWakeReason)[keyof typeof TeachingWakeReason] {
    return current.input_revision !== baseline.input_revision
      ? TeachingWakeReason.INPUT
      : TeachingWakeReason.PENDING;
  }
}
