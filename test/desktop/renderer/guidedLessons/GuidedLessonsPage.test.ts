// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  GuidedLessonFailure,
  GuidedLessonReadAction,
  LessonStatus,
  type GuidedLessonDetail,
  type GuidedLessonReply,
} from '#contracts/GuidedLessons.js';
import { GuidedLessonsPage } from '../../../../src/desktop/renderer/guidedLessons/GuidedLessonsPage.js';
import type { TeacherLessonStudio } from '../../../../src/desktop/renderer/guidedLessons/TeacherLessonStudio.js';
import type { GuidedLessonBridge } from '../../../../src/desktop/renderer/guidedLessons/UseGuidedLessonBridge.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import { createLessonPlaybackFixture } from '../../../server/features/guidedLessons/LessonPlaybackFixture.js';

const bridge = vi.hoisted(() => ({
  read: vi.fn<GuidedLessonBridge['read']>(),
  command: vi.fn<GuidedLessonBridge['command']>(),
  clearError: vi.fn<GuidedLessonBridge['clearError']>(),
}));

vi.mock('../../../../src/desktop/renderer/guidedLessons/UseGuidedLessonBridge.js', () => ({
  useGuidedLessonBridge: (): GuidedLessonBridge => ({ ...bridge, error: null }),
}));

vi.mock('../../../../src/desktop/renderer/guidedLessons/TeacherLessonStudio.js', () => ({
  TeacherLessonStudio: (props: ComponentProps<typeof TeacherLessonStudio>) =>
    createElement(
      'div',
      null,
      createElement('p', { 'data-testid': 'current-studio' }, props.lesson.id),
      createElement('p', { 'data-testid': 'current-preview' }, props.preview?.sceneId ?? 'none'),
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => void props.onPreviewScene('watch'),
        },
        'Load scene preview',
      ),
    ),
}));

beforeAll(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
});

afterAll(() => {
  Reflect.deleteProperty(document, 'fonts');
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
  Object.defineProperty(window, 'tro', {
    configurable: true,
    value: {} satisfies Partial<DesktopBridge>,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function createDeferredReply() {
  let resolveReply: (reply: GuidedLessonReply) => void = () => {};
  const promise = new Promise<GuidedLessonReply>((resolve) => {
    resolveReply = resolve;
  });
  return { promise, resolve: resolveReply };
}

it('discards a preview that finishes after the teacher opens another lesson', async () => {
  const fixture = createLessonPlaybackFixture();
  const createDetail = (id: string, title: string): GuidedLessonDetail => ({
    id,
    classId: 'class-1',
    title,
    status: LessonStatus.PREVIEW_READY,
    version: 1,
    language: 'en',
    updatedAt: '2026-10-10T22:00:00.000Z',
    releaseId: null,
    error: null,
    input: fixture.input,
    plan: fixture.plan,
    contentHash: fixture.record.contentHash,
    review: null,
    visualReview: null,
    manifest: fixture.record.manifest,
    scriptApproved: true,
    previewApproved: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      generationAttempts: 0,
      speechCharacters: 0,
      speechSeconds: 0,
      artifactBytes: 0,
    },
  });
  const first = createDetail('lesson-a', 'First lesson');
  const second = createDetail('lesson-b', 'Second lesson');
  const deferred = createDeferredReply();
  bridge.read.mockImplementation(async (request) => {
    if (request.action === GuidedLessonReadAction.LIST) {
      return {
        kind: 'list',
        classes: [
          {
            id: 'class-1',
            teacherId: 'teacher-1',
            name: 'Python class',
            courseRevisionId: fixture.input.courseRevisionId,
          },
        ],
        lessons: [first, second],
      };
    }
    if (request.action === GuidedLessonReadAction.DETAIL) {
      return { kind: 'detail', lesson: request.lessonId === first.id ? first : second };
    }
    if (request.action === GuidedLessonReadAction.PREVIEW) {
      return deferred.promise;
    }
    return { kind: 'requests', requests: [] };
  });
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(GuidedLessonsPage, {
          userId: 'teacher-1',
          initialClassId: 'class-1',
          onChooseClass: vi.fn(),
          onRoleChange: vi.fn(),
        }),
      }),
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: /First lesson/ }));
  await waitFor(() => {
    expect(screen.getByTestId('current-studio').textContent).toBe(first.id);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load scene preview' }));
  fireEvent.click(screen.getByRole('button', { name: /Back to library/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Second lesson/ }));
  await waitFor(() => {
    expect(screen.getByTestId('current-studio').textContent).toBe(second.id);
  });
  await act(async () => {
    deferred.resolve({
      kind: 'projection',
      projection: fixture.projection,
      reflectionPrompt: fixture.plan.reflectionPrompt,
      notes: [],
    });
    await deferred.promise;
  });
  expect(screen.getByTestId('current-preview').textContent).toBe('none');
});

it('ends failed material loading and retries successfully, retaining the requested revision', async () => {
  const fixture = createLessonPlaybackFixture();
  const firstRead = createDeferredReply();
  const alternateRevisionId = 'alternate-revision';
  const teacherInput: Extract<GuidedLessonReply, { kind: 'teacherInput' }> = {
    kind: 'teacherInput',
    classId: 'class-1',
    passages: fixture.input.passages,
    revisions: [
      {
        id: fixture.input.courseRevisionId,
        title: 'Approved Python material',
        sections: [
          {
            id: fixture.input.conceptId,
            title: 'Running total',
            passageIds: fixture.input.passages.map((passage) => passage.passageId),
          },
        ],
      },
      {
        id: alternateRevisionId,
        title: 'Another approved revision',
        sections: [
          {
            id: 'alternate-section',
            title: 'Another section',
            passageIds: fixture.input.passages.map((passage) => passage.passageId),
          },
        ],
      },
    ],
  };
  const failed: GuidedLessonReply = {
    kind: 'failed',
    code: GuidedLessonFailure.UNAVAILABLE,
    message: 'Approved material is temporarily unavailable.',
  };
  let materialReads = 0;
  bridge.read.mockImplementation(async (request) => {
    if (request.action === GuidedLessonReadAction.LIST) {
      return {
        kind: 'list',
        classes: [
          {
            id: 'class-1',
            teacherId: 'teacher-1',
            name: 'Python class',
            courseRevisionId: fixture.input.courseRevisionId,
          },
        ],
        lessons: [],
      };
    }
    if (request.action === GuidedLessonReadAction.TEACHER_INPUT) {
      materialReads++;
      if (materialReads === 1) {
        return firstRead.promise;
      }
      if (materialReads === 3) {
        return failed;
      }
      return {
        ...teacherInput,
        passages: teacherInput.passages.map((passage) => ({
          ...passage,
          publicationId: request.courseRevisionId ?? fixture.input.courseRevisionId,
        })),
      };
    }
    return { kind: 'requests', requests: [] };
  });
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(GuidedLessonsPage, {
          userId: 'teacher-1',
          initialClassId: 'class-1',
          onChooseClass: vi.fn(),
          onRoleChange: vi.fn(),
        }),
      }),
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Create a guided lesson' }));
  expect(screen.getByText('Loading approved material…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', true);
  await act(async () => {
    firstRead.resolve(failed);
    await firstRead.promise;
  });
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.queryByText('Loading approved material…')).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Approved source' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => {
    expect(screen.getByRole('combobox', { name: 'Approved source' })).toHaveProperty(
      'value',
      fixture.input.courseRevisionId,
    );
  });
  expect(bridge.read).toHaveBeenLastCalledWith(
    {
      action: GuidedLessonReadAction.TEACHER_INPUT,
      classId: 'class-1',
    },
    'teacherInput',
  );
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

  fireEvent.change(screen.getByRole('combobox', { name: 'Approved source' }), {
    target: { value: alternateRevisionId },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
  expect(screen.getByRole('combobox', { name: 'Approved source' })).toHaveProperty(
    'value',
    alternateRevisionId,
  );
  expect(bridge.read).toHaveBeenLastCalledWith(
    {
      action: GuidedLessonReadAction.TEACHER_INPUT,
      classId: 'class-1',
      courseRevisionId: alternateRevisionId,
    },
    'teacherInput',
  );
  expect(screen.queryByText('Loading approved material…')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(materialReads).toBe(4);
  expect(bridge.command).not.toHaveBeenCalled();
});
