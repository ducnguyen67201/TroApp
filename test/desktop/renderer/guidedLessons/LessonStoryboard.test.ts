// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LessonStoryboard } from '../../../../src/desktop/renderer/guidedLessons/LessonStoryboard.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import { createLessonFixture } from '../../../server/features/guidedLessons/LessonFixture.js';
import { createSourceLessonFixture } from '../../../server/features/guidedLessons/SourceLessonFixture.js';

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function createStoryboard(props: ComponentProps<typeof LessonStoryboard>) {
  return createElement(LocaleProvider, {
    children: createElement(LessonStoryboard, props),
  });
}

it('illustrates only canonical states belonging to the selected scene and labels them as script content', () => {
  const { input, plan } = createLessonFixture();
  const opening = plan.scenes.find((scene) => scene.sceneId === 'watch');
  const continuation = plan.scenes.find((scene) => scene.sceneId === 'continue');
  if (!opening || !continuation) {
    throw new Error('The canonical script scenes are missing.');
  }
  const view = render(createStoryboard({ scene: opening, input, checkpoint: undefined }));
  expect(screen.queryByText('12', { selector: 'strong' })).toBeNull();
  const code = input.codeBlocks[0];
  if (!code) {
    throw new Error('The approved code fixture is missing.');
  }
  expect(view.container.querySelector('pre')?.textContent).toBe(
    code.lines.map((line) => line.text).join('\n'),
  );
  expect(
    screen.getByText('Based on the script and approved sources. This is not a rendered video.'),
  ).toBeTruthy();
  view.rerender(createStoryboard({ scene: continuation, input, checkpoint: undefined }));
  expect(screen.getAllByText('12', { selector: 'strong' }).length).toBeGreaterThan(0);
});

it('keeps a checkpoint illustration separate from its worked explanation and answer', () => {
  const { input, plan } = createLessonFixture();
  const scene = plan.scenes.find((item) => item.sceneId === 'predict');
  const checkpoint = plan.checkpoints.find((item) => item.sceneId === scene?.sceneId);
  if (!scene || !checkpoint) {
    throw new Error('The checkpoint fixture is missing.');
  }
  render(createStoryboard({ scene, input, checkpoint }));
  expect(screen.getByRole('heading', { name: checkpoint.question })).toBeTruthy();
  for (const beat of checkpoint.workedExplanation) {
    expect(screen.queryByText(beat.text)).toBeNull();
  }
  expect(screen.queryByText('2', { selector: 'strong' })).toBeNull();
  expect(screen.getByText('Let students predict before showing the worked answer.')).toBeTruthy();
});

it('uses the exact cited source range and callout text for an annotated source scene', () => {
  const { input } = createLessonFixture();
  const passage = input.passages[0];
  if (!passage) {
    throw new Error('The source fixture is missing.');
  }
  const startOffset = 7;
  const endOffset = passage.text.length - 1;
  const sourceRefs = [{ passageId: passage.passageId, startOffset, endOffset }];
  render(
    createStoryboard({
      input,
      checkpoint: undefined,
      scene: {
        sceneId: 'source-scene',
        title: 'Read the approved source',
        templateVersion: '1.0.0',
        layoutVariant: 'standard',
        sourceRefs,
        narration: [],
        kind: 'annotatedSource',
        params: {
          assetId: 'source-figure',
          callouts: [
            {
              calloutId: 'source-callout',
              regionId: 'source-region',
              label: 'The total persists between iterations.',
              x: 0.2,
              y: 0.3,
              sourceRefs,
            },
          ],
        },
      },
    }),
  );
  expect(screen.getByRole('blockquote').textContent).toBe(
    passage.text.slice(startOffset, endOffset),
  );
  expect(screen.getByText('The total persists between iterations.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve preview' })).toBeNull();
});

it('illustrates approved general-material points without code, trace values or a fabricated checkpoint', () => {
  const { input, plan } = createSourceLessonFixture();
  const scene = plan.scenes[0];
  if (scene?.kind !== 'sourceExplanation') {
    throw new Error('The source fixture needs a source explanation.');
  }
  const view = render(createStoryboard({ input, scene, checkpoint: undefined }));
  expect(screen.getByRole('heading', { name: scene.title })).toBeTruthy();
  for (const point of scene.params.points) {
    expect(screen.getByText(point.text)).toBeTruthy();
  }
  expect(view.container.querySelector('pre')).toBeNull();
  expect(screen.queryByText('Python')).toBeNull();
  expect(screen.queryByText('Question')).toBeNull();
  view.rerender(createStoryboard({ input, scene, checkpoint: undefined, compact: true }));
  expect(view.container.textContent).toContain(scene.params.points[0]?.text);
  expect(view.container.querySelector('code')).toBeNull();
});
