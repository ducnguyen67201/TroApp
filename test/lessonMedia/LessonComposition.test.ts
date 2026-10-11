import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useCurrentFrame } from 'remotion';
import { describe, expect, it, vi } from 'vitest';
import { LessonLanguage } from '#contracts/GuidedLessons.js';
import { buildLessonProjection } from '../../src/server/features/guidedLessons/domain/BuildLessonProjection.js';
import { hashLessonValue } from '../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import {
  readLessonDurationFrames,
  readVisibleState,
  LessonComposition,
} from '../../src/lessonMedia/LessonComposition.js';
import { createLessonFixture } from '../server/features/guidedLessons/LessonFixture.js';
import { createSourceLessonFixture } from '../server/features/guidedLessons/SourceLessonFixture.js';

vi.mock('remotion', async (importOriginal) => {
  const remotion = await importOriginal<typeof import('remotion')>();
  return {
    ...remotion,
    useCurrentFrame: vi.fn<typeof remotion.useCurrentFrame>().mockReturnValue(29),
  };
});

describe('trusted lesson frame selection', () => {
  it.each([
    {
      language: LessonLanguage.VI,
      sceneTitle: 'Tong sau vong lap',
      label: 'Kết quả',
      absent: 'Output',
    },
    {
      language: LessonLanguage.EN,
      sceneTitle: 'A quoted term: tiếng Việt',
      label: 'Output',
      absent: 'Kết quả',
    },
  ])(
    'uses explicit $language lesson data for labels instead of guessing from the text',
    ({ language, sceneTitle, label, absent }) => {
      const fixture = createLessonFixture();
      fixture.progress.revealed.push('checkpoint-1');
      const projection = buildLessonProjection({ ...fixture, sceneId: 'continue' });
      vi.mocked(useCurrentFrame).mockReturnValue(readLessonDurationFrames(projection) - 1);
      const markup = renderToStaticMarkup(
        createElement(LessonComposition, {
          projection: { ...projection, language, sceneTitle },
          audioSources: {},
          sourceAssets: {},
        }),
      );
      expect(markup).toContain(label);
      expect(markup).not.toContain(absent);
    },
  );

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

  it('uses measured source narration duration without creating an execution state', () => {
    const fixture = createSourceLessonFixture();
    const projection = buildLessonProjection(fixture);
    expect(readVisibleState(projection, 0)).toBeUndefined();
    expect(readVisibleState(projection, 29)).toBeUndefined();
    expect(readLessonDurationFrames(projection)).toBe(30);
  });
});
