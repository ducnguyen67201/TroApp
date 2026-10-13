import type { LessonVideo } from '#contracts/LessonVideos.js';

interface RenderRecoveryState {
  screens: readonly Pick<LessonVideo['screens'][number], 'clipId' | 'renderAttempts'>[];
  combineAttempts: number;
  renderRecoveries: number;
  videoId: string | null;
  videoRevision: number | null;
  revision: number;
  settings: { render: { attempts: number; recoveries: number } };
}

/** Continue adds a bounded batch, never erases executions already reserved before I/O. */
export function readLessonRenderAttemptLimit(lesson: RenderRecoveryState): number {
  return lesson.settings.render.attempts * (1 + lesson.renderRecoveries);
}

export function needsLessonRenderRecovery(lesson: RenderRecoveryState): boolean {
  const limit = readLessonRenderAttemptLimit(lesson);
  return (
    lesson.screens.some((screen) => !screen.clipId && screen.renderAttempts >= limit) ||
    lesson.combineAttempts >= limit
  );
}

/** Every remaining media operation must fit the current ceiling or one saved recovery. */
export function canContinueLessonRendering(lesson: RenderRecoveryState): boolean {
  const maximum = lesson.settings.render.attempts * (1 + lesson.settings.render.recoveries);
  return (
    lesson.screens.length > 0 &&
    !(lesson.videoId !== null && lesson.videoRevision === lesson.revision) &&
    lesson.screens.every((screen) => screen.clipId !== null || screen.renderAttempts < maximum) &&
    lesson.combineAttempts < maximum
  );
}
