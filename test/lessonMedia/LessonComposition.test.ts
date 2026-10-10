import { describe, expect, it } from 'vitest';
import { buildLessonProjection } from '../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';
import { hashLessonValue } from '../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import {
  readLessonDurationFrames,
  readVisibleState,
} from '../../src/lessonMedia/LessonComposition.js';
import { createLessonFixture } from '../server/features/guidedLessons/LessonFixture.js';

describe('trusted lesson frame selection', () => {
  it('never invents a hidden after state for a pending checkpoint', () => {
    const fixture = createLessonFixture();
    const projection = buildLessonProjection({
      ...fixture,
      sceneId: 'predict',
      progress: { ...fixture.progress, sceneId: 'predict' },
      hashValue: hashLessonValue,
    });
    expect(readVisibleState(projection, 15)?.stateView).toBe('before');
    expect(readVisibleState(projection, 999)?.stateView).toBe('before');
    expect(readLessonDurationFrames(projection)).toBeGreaterThanOrEqual(30);
  });
});
