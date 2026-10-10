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
