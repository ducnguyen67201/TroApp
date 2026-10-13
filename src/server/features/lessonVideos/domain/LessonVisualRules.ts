import type { LessonVisualBrief, StoredLessonVisual } from '#contracts/LessonVisuals.js';

/** Stable priority ordering makes the writer's proposals deterministic and bounded. */
export function selectLessonVisualBriefs(
  briefs: LessonVisualBrief[],
  screenCount: number,
  maximum: number,
): LessonVisualBrief[] {
  const selected: LessonVisualBrief[] = [];
  for (const brief of [...briefs].sort(
    (left, right) => left.priority - right.priority || left.position - right.position,
  )) {
    if (selected.length >= maximum) {
      break;
    }
    if (
      brief.position < screenCount &&
      !selected.some((item) => item.position === brief.position)
    ) {
      selected.push(brief);
    }
  }
  return selected;
}

export function canReuseLessonVisual(visual: StoredLessonVisual, inputDigest: string): boolean {
  return (
    visual.sourceId !== null &&
    visual.sourceComplete &&
    visual.inputDigest === inputDigest &&
    visual.diagnostic === null
  );
}
