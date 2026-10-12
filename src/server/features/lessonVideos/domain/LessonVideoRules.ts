import {
  LessonVideoFailure,
  LessonVideoStatus,
  type LessonVideo,
} from '#contracts/LessonVideos.js';

export class LessonVideoError extends Error {
  constructor(readonly code: (typeof LessonVideoFailure)[keyof typeof LessonVideoFailure]) {
    super(code);
  }
}

export function isLessonActive(status: LessonVideo['status']): boolean {
  return status === LessonVideoStatus.QUEUED || status === LessonVideoStatus.RUNNING;
}

/** A saved script remains useful even when no media operation can be resumed. */
export function canContinueLesson(
  lesson: Pick<LessonVideo, 'status' | 'screens' | 'error'>,
): boolean {
  return (
    !isLessonActive(lesson.status) &&
    lesson.status !== LessonVideoStatus.READY &&
    lesson.screens.length > 0 &&
    lesson.error !== LessonVideoFailure.BUDGET
  );
}
