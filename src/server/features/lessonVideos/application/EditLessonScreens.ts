import type { LessonContent, LessonScreen } from '#contracts/LessonVideos.js';
import {
  LessonVisualDegradation,
  LessonVisualStatus,
  LessonVisualTreatment,
  type LessonVisualDegradation as VisualDegradation,
} from '#contracts/LessonVisuals.js';
import type { StoredLesson } from './LessonVideoPorts.js';

type SavedScreen = StoredLesson['screens'][number];

/** An explicit new revision may rerender unfinished media; completed clips keep their history. */
export function resetUnfinishedLessonRenders(screens: SavedScreen[]): SavedScreen[] {
  return screens.map((screen) => (screen.clipId ? screen : { ...screen, renderAttempts: 0 }));
}

/** Reordered unchanged screens retain their server-owned IDs, source and media. */
export function editLessonScreens(
  lesson: StoredLesson,
  content: LessonContent,
  newId: () => string,
): Pick<StoredLesson, 'screens' | 'visuals'> {
  const usedIds = new Set<string>();
  const invalidatedIds = new Set<string>();
  const matches = content.screens.map((screen) => {
    const previous = lesson.screens.find(
      (candidate) => !usedIds.has(candidate.id) && hasSameContent(candidate, screen),
    );
    if (previous) {
      usedIds.add(previous.id);
    }
    return previous;
  });
  const screens = content.screens.map((screen, index) => {
    const candidate = lesson.screens[index];
    const previous =
      matches[index] ?? (candidate && !usedIds.has(candidate.id) ? candidate : undefined);
    if (previous) {
      usedIds.add(previous.id);
    }
    const sameNarration = previous?.narration === screen.narration;
    const unchanged = previous !== undefined && hasSameContent(previous, screen);
    if (previous && !unchanged) {
      invalidatedIds.add(previous.id);
    }
    const updated: SavedScreen = {
      ...screen,
      id: previous?.id ?? newId(),
      audioId: sameNarration ? previous.audioId : null,
      clipId: unchanged ? previous.clipId : null,
      durationSeconds: sameNarration ? previous.durationSeconds : 0,
      silent: !sameNarration || previous.silent,
      speechAttempts: previous?.speechAttempts ?? lesson.settings.speech.attempts,
      renderAttempts: unchanged ? previous.renderAttempts : 0,
      ...(previous?.visual ? { visual: previous.visual } : {}),
    };
    return !unchanged
      ? invalidateScreenAnimation(updated, LessonVisualDegradation.EDITED)
      : updated;
  });
  return {
    screens,
    visuals: invalidateVisualSources(lesson, invalidatedIds),
  };
}

/** Invalidate references, retaining stored artifact rows and the consumed attempt ledger. */
export function invalidateLessonAnimations(
  lesson: StoredLesson,
  screenIds: ReadonlySet<string>,
  reason: VisualDegradation,
): Pick<StoredLesson, 'screens' | 'visuals'> {
  return {
    screens: lesson.screens.map((screen) =>
      screenIds.has(screen.id) ? invalidateScreenAnimation(screen, reason) : screen,
    ),
    visuals: invalidateVisualSources(lesson, screenIds),
  };
}

function hasSameContent(previous: LessonScreen, next: LessonScreen): boolean {
  return (
    previous.layout === next.layout &&
    previous.title === next.title &&
    previous.narration === next.narration &&
    JSON.stringify(previous.points) === JSON.stringify(next.points)
  );
}

function invalidateScreenAnimation(screen: SavedScreen, reason: VisualDegradation): SavedScreen {
  if (
    screen.visual?.treatment !== LessonVisualTreatment.CUSTOM &&
    screen.visual?.status !== LessonVisualStatus.DEGRADED
  ) {
    return screen;
  }
  return {
    ...screen,
    clipId: null,
    renderAttempts: 0,
    visual: {
      treatment: LessonVisualTreatment.BASELINE,
      status: LessonVisualStatus.DEGRADED,
      degradationReason: reason,
    },
  };
}

function invalidateVisualSources(
  lesson: StoredLesson,
  screenIds: ReadonlySet<string>,
): StoredLesson['visuals'] {
  return lesson.visuals.map((visual) =>
    screenIds.has(visual.screenId)
      ? {
          ...visual,
          sourceId: null,
          sourceDigest: null,
          inputDigest: null,
          sourceComplete: false,
          diagnostic: null,
        }
      : visual,
  );
}
