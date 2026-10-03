import {
  StudentActivityKind,
  type StudentActivity,
  type TeachingInteraction,
} from '#contracts/StudentActivity.js';
import type { DesktopObservationRegion } from '#contracts/DesktopObservation.js';
interface StudentAttempt {
  sequence: number;
  stepId: string | null;
  kind: 'click' | 'drag' | 'key' | 'scroll' | 'unpaired_release';
  pressPoint: StudentActivity['point'];
  releasePoint: StudentActivity['point'];
  sourceNear: boolean | null;
  destinationNear: boolean | null;
}
/** A bounded event history, independent of native input_revision. Metadata is not app success. */
export class StudentInteractionTracker {
  private stepId: string | null = null;
  private expected: TeachingInteraction | null = null;
  private press: StudentActivity | null = null;
  private dragged = false;
  private sequence = 0;
  private readonly attempts: StudentAttempt[] = [];
  private attemptCount = 0;
  registerStep(stepId: string, expected: TeachingInteraction | null): void {
    if (this.stepId !== stepId) {
      this.attemptCount = 0;
    }
    this.stepId = stepId;
    this.expected = expected;
  }
  invalidateTarget(): void {
    this.expected = null;
  }
  recordActivity(activity: StudentActivity): void {
    this.sequence += 1;
    if (activity.kind === StudentActivityKind.PRESS) {
      this.press = activity;
      this.dragged = false;
      return;
    }
    if (activity.kind === StudentActivityKind.DRAG) {
      this.dragged = this.press !== null;
      return;
    }
    const expected = this.expected;
    const press = this.press;
    const isRelease = activity.kind === StudentActivityKind.RELEASE;
    const paired = isRelease && press !== null && press.button === activity.button;
    const kind =
      activity.kind === StudentActivityKind.KEY
        ? 'key'
        : activity.kind === StudentActivityKind.SCROLL
          ? 'scroll'
          : !paired
            ? 'unpaired_release'
            : this.dragged
              ? 'drag'
              : 'click';
    this.attemptCount += 1;
    this.attempts.push({
      sequence: this.sequence,
      stepId: this.stepId,
      kind,
      pressPoint: isRelease ? (press?.point ?? null) : null,
      releasePoint: activity.point,
      sourceNear:
        paired && expected?.kind === 'drag' ? containsPoint(expected.source, press.point) : null,
      destinationNear:
        paired && expected?.kind === 'drag'
          ? containsPoint(expected.destination, activity.point)
          : paired && expected?.kind === 'click'
            ? containsPoint(expected.target, activity.point)
            : null,
    });
    if (this.attempts.length > 12) {
      this.attempts.shift();
    }
    if (isRelease) {
      this.press = null;
      this.dragged = false;
    }
  }
  readEvidence() {
    return {
      activitySequence: this.sequence,
      stepId: this.stepId,
      expected: this.expected,
      attemptCount: this.attemptCount,
      attempts: [...this.attempts],
      limitation:
        'Approximate normalized target matching. Input is an attempt, not app acceptance. Missing metadata or an unchanged screenshot never proves that no click occurred.',
    };
  }
}

function containsPoint(bounds: DesktopObservationRegion, point: StudentActivity['point']): boolean {
  const tolerance = 0.01;
  return (
    point !== null &&
    point.x >= bounds.x - tolerance &&
    point.x <= bounds.x + bounds.width + tolerance &&
    point.y >= bounds.y - tolerance &&
    point.y <= bounds.y + bounds.height + tolerance
  );
}
