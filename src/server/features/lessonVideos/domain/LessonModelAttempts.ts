import {
  LessonModelAttemptState,
  LessonModelRole,
  type LessonModelAttempt,
} from '#contracts/LessonVisuals.js';
import { LessonVideoFailure } from '#contracts/LessonVideos.js';
import { LessonVideoError } from './LessonVideoRules.js';
import type { StoredLesson } from '../application/LessonVideoPorts.js';

/** The lesson owns this ledger across edits and restarts. CAS fences concurrent dispatches. */
export function beginLessonModelAttempt(
  lesson: StoredLesson,
  attempt: LessonModelAttempt,
): StoredLesson {
  const isContent = attempt.role === LessonModelRole.CONTENT;
  const policy = isContent ? lesson.settings.content : lesson.settings.visual;
  const previous = lesson.modelAttempts.filter(
    (item) => item.role === attempt.role && item.screenId === attempt.screenId,
  );
  if (
    attempt.state !== LessonModelAttemptState.DISPATCHED ||
    attempt.usage !== null ||
    !attempt.usageUncertain ||
    previous.some((item) => item.state === LessonModelAttemptState.DISPATCHED) ||
    previous.length >= policy.attempts ||
    attempt.ordinal !== previous.length + 1 ||
    attempt.inputTokenLimit > policy.inputTokens ||
    attempt.outputTokenLimit !== policy.outputTokens ||
    lesson.modelAttempts.some((item) => item.id === attempt.id) ||
    (isContent
      ? attempt.screenId !== null
      : !lesson.settings.visual.enabled ||
        !lesson.visuals.some((item) => item.screenId === attempt.screenId))
  ) {
    throw new LessonVideoError(LessonVideoFailure.BUDGET);
  }
  const maximum =
    lesson.settings.content.attempts +
    (lesson.settings.visual.enabled
      ? lesson.settings.visual.maxScenes * lesson.settings.visual.attempts
      : 0);
  if (lesson.modelAttempts.length >= maximum) {
    throw new LessonVideoError(LessonVideoFailure.BUDGET);
  }
  return { ...lesson, modelAttempts: [...lesson.modelAttempts, attempt] };
}

export function settleLessonModelAttempt(
  lesson: StoredLesson,
  attemptId: string,
  result: Pick<LessonModelAttempt, 'state' | 'usage' | 'usageUncertain'>,
): StoredLesson {
  const attempt = lesson.modelAttempts.find((item) => item.id === attemptId);
  if (
    !attempt ||
    attempt.state !== LessonModelAttemptState.DISPATCHED ||
    result.state === LessonModelAttemptState.DISPATCHED
  ) {
    throw new LessonVideoError(LessonVideoFailure.STALE);
  }
  const modelAttempts = lesson.modelAttempts.map((item) =>
    item.id === attemptId ? { ...item, ...result } : item,
  );
  return {
    ...lesson,
    modelAttempts,
    inputTokens: modelAttempts.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
    outputTokens: modelAttempts.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0),
    usageUncertain: modelAttempts.some((item) => item.usageUncertain),
  };
}

/** General state writes may append or settle attempts, but never erase paid history. */
export function preservesLessonModelAttempts(previous: StoredLesson, next: StoredLesson): boolean {
  return previous.modelAttempts.every((attempt, index) => {
    const updated = next.modelAttempts[index];
    if (!updated) {
      return false;
    }
    return (
      attempt.id === updated.id &&
      attempt.role === updated.role &&
      attempt.screenId === updated.screenId &&
      attempt.ordinal === updated.ordinal &&
      attempt.requestDigest === updated.requestDigest &&
      attempt.inputTokenLimit === updated.inputTokenLimit &&
      attempt.outputTokenLimit === updated.outputTokenLimit &&
      (attempt.state === LessonModelAttemptState.DISPATCHED ||
        JSON.stringify(attempt) === JSON.stringify(updated))
    );
  });
}
