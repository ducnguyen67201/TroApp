// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LessonCommand,
  LessonLayout,
  LessonVideoSchema,
  LessonVideoStage,
  LessonVideoStatus,
  type LessonVideo,
  type LessonVideoCommand,
} from '#contracts/LessonVideos.js';
import {
  LessonVisualDegradation,
  LessonVisualStatus,
  LessonVisualTreatment,
} from '#contracts/LessonVisuals.js';
import { LessonVideoStudio } from '../../../../src/desktop/renderer/lessonVideos/LessonVideoStudio.js';

import { LessonGenerationProgress } from '../../../../src/desktop/renderer/lessonVideos/LessonGenerationProgress.js';

vi.mock('@remotion/player', () => ({ Player: () => null }));
vi.mock('../../../../src/desktop/renderer/lessonVideos/LessonVideoPlayer.js', () => ({
  LessonVideoPlayer: () => null,
}));

const lessonId = '11111111-1111-4111-8111-111111111111';
const classId = '22222222-2222-4222-8222-222222222222';
const videoId = '33333333-3333-4333-8333-333333333333';
const screenIds = [
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
];

function createLesson(): LessonVideo {
  return LessonVideoSchema.parse({
    id: lessonId,
    classId,
    title: 'Counting choices',
    prompt: 'Explain how to count choices.',
    locale: 'en',
    revision: 1,
    status: LessonVideoStatus.RUNNING,
    stage: LessonVideoStage.VISUAL,
    error: null,
    screens: screenIds.map((id, index) => ({
      id,
      layout: LessonLayout.EXAMPLE,
      title: `Scene ${String(index + 1)}`,
      points: ['There are three even digits.'],
      narration: 'Choose two, four or six.',
      audioId: null,
      clipId: null,
      silent: false,
      durationSeconds: 10,
      speechAttempts: 0,
      renderAttempts: 0,
    })),
    videoId: null,
    videoRevision: null,
    inputTokens: 1000,
    outputTokens: 300,
    reservedMicroUsd: 150000,
    usageUncertain: false,
    createdAt: '2026-10-12T14:00:00.000Z',
    updatedAt: '2026-10-12T14:00:00.000Z',
    canContinue: false,
  });
}

function renderStudio(lesson: LessonVideo, vietnamese = false) {
  const execute = vi.fn<(command: LessonVideoCommand) => Promise<void>>().mockResolvedValue();
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LessonVideoStudio, {
        lesson,
        vi: vietnamese,
        busy: false,
        execute,
        back: () => {},
      }),
    }),
  );
  return execute;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows persisted animation progress and keeps the content preview clearly standard', () => {
  const lesson = createLesson();
  lesson.screens = lesson.screens.map((item, index) => ({
    ...item,
    visual: {
      treatment: index === 0 ? LessonVisualTreatment.BASELINE : LessonVisualTreatment.CUSTOM,
      status: index === 2 ? LessonVisualStatus.PENDING : LessonVisualStatus.SOURCE_SAVED,
      degradationReason: null,
    },
  }));
  renderStudio(lesson);
  expect(screen.getByRole('status').textContent).toBe('Generating animation 2 of 2');
  expect(
    screen.getByText('Content preview with standard animation · not the finished video'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /3\. Scene 3/ }));
  expect(screen.getByText('Scene 3: Custom animation pending')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Continue rendering' })).toBeNull();
});

it('keeps a finished degraded lesson ready and explains standard animation inline', () => {
  const lesson = createLesson();
  lesson.status = LessonVideoStatus.READY;
  lesson.videoId = videoId;
  lesson.videoRevision = lesson.revision;
  lesson.screens = lesson.screens.map((item, index) => ({
    ...item,
    visual: {
      treatment: index === 0 ? LessonVisualTreatment.BASELINE : LessonVisualTreatment.CUSTOM,
      status: index === 0 ? LessonVisualStatus.DEGRADED : LessonVisualStatus.READY,
      degradationReason: index === 0 ? LessonVisualDegradation.BUDGET : null,
    },
  }));
  const execute = renderStudio(lesson);
  expect(screen.getByRole('status').textContent).toBe(
    'Video ready · some scenes use standard animation',
  );
  expect(
    screen.getByText(
      'The custom animation allowance was reached. This scene uses standard animation and keeps its lesson content.',
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Continue rendering' })).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

it('uses saved server eligibility for Continue and never implies new AI attempts', () => {
  const lesson = createLesson();
  lesson.status = LessonVideoStatus.STOPPED;
  lesson.canContinue = true;
  const execute = renderStudio(lesson);
  fireEvent.click(screen.getByRole('button', { name: 'Continue rendering' }));
  expect(execute).toHaveBeenCalledWith({
    kind: LessonCommand.CONTINUE,
    id: lessonId,
    revision: lesson.revision,
  });
  expect(
    screen.getByText(
      'Continue reuses saved content and animation; it does not grant new AI attempts.',
    ),
  ).toBeTruthy();
});

it('does not offer Continue when the saved job has no eligible remaining work', () => {
  const lesson = createLesson();
  lesson.status = LessonVideoStatus.STOPPED;
  renderStudio(lesson);
  expect(screen.queryByRole('button', { name: 'Continue rendering' })).toBeNull();
});

it('shows older scenes as standard animation without claiming a failed enhancement', () => {
  const lesson = createLesson();
  lesson.status = LessonVideoStatus.READY;
  lesson.videoId = videoId;
  lesson.videoRevision = lesson.revision;
  renderStudio(lesson, true);
  expect(screen.getByRole('status').textContent).toBe('Video sẵn sàng');
  expect(screen.getByText('Cảnh 1: Hoạt ảnh tiêu chuẩn')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('shows saved stage counts without marking earlier steps complete merely because a later stage runs', () => {
  const lesson = createLesson();
  lesson.stage = LessonVideoStage.CLIP;
  lesson.screens = lesson.screens.map((item, index) => ({
    ...item,
    audioId: index === 0 ? videoId : null,
    clipId: index === 0 ? videoId : null,
  }));
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LessonGenerationProgress, {
        lesson,
        vi: false,
        busy: false,
        execute: vi.fn<(command: LessonVideoCommand) => Promise<void>>().mockResolvedValue(),
        close: () => {},
        preview: () => {},
      }),
    }),
  );
  const narrationStep = screen.getByText('Prepare narration or captions').closest('li');
  expect(narrationStep?.getAttribute('data-complete')).toBe('false');
  if (!narrationStep) {
    throw new Error('Missing narration step');
  }
  expect(within(narrationStep).getByText('1/3')).toBeTruthy();
  expect(screen.getByText('Render scenes').closest('li')?.getAttribute('aria-current')).toBe(
    'step',
  );
  expect(
    screen.getByText('Combine the finished video').closest('li')?.getAttribute('data-complete'),
  ).toBe('false');
});

it('closes progress independently of the explicit cancellation command', () => {
  const lesson = createLesson();
  const close = vi.fn<() => void>();
  const execute = vi.fn<(command: LessonVideoCommand) => Promise<void>>().mockResolvedValue();
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LessonGenerationProgress, {
        lesson,
        vi: false,
        busy: false,
        execute,
        close,
        preview: () => {},
      }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Back to library' }));
  expect(close).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }));
  expect(execute).toHaveBeenCalledWith({
    kind: LessonCommand.CANCEL,
    id: lesson.id,
    revision: lesson.revision,
  });
});

it('keeps saved content accessible while video rendering is active', () => {
  const preview = vi.fn<() => void>();
  const execute = vi.fn<(command: LessonVideoCommand) => Promise<void>>().mockResolvedValue();
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LessonGenerationProgress, {
        lesson: createLesson(),
        vi: false,
        busy: false,
        execute,
        close: () => {},
        preview,
      }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'View saved content' }));
  expect(preview).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});
