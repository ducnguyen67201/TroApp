import type { LearnerProjection, LessonPhase, RenderManifest } from '#contracts/GuidedLessons.js';
import { buildLessonProjection } from '../../../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';
import { createLessonFixture } from './LessonFixture.js';

/** Server-built projections keep renderer tests outside backend implementation boundaries. */
export function createLessonPlaybackFixture(sceneId = 'predict') {
  const fixture = createLessonFixture();
  const projection = buildLessonProjection({
    ...fixture,
    sceneId,
    progress: { ...fixture.progress, sceneId },
  });
  return { ...fixture, projection };
}

/** Teacher UI tests obtain real projections without importing backend implementation. */
export function createTeacherLessonPreviewFixture(
  sceneId: string,
  phase: LessonPhase,
  hashValue: (value: unknown) => string,
  manifest?: RenderManifest,
): LearnerProjection {
  const fixture = createLessonFixture();
  return buildLessonProjection({
    ...fixture,
    record: manifest ? { ...fixture.record, manifest } : fixture.record,
    hashValue,
    sceneId,
    phase,
    teacherPreview: true,
    progress: { ...fixture.progress, sceneId },
  });
}
