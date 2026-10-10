// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { LessonStatus } from '#contracts/GuidedLessons.js';
import { TeacherLessonStudio } from '../../../../src/desktop/renderer/guidedLessons/TeacherLessonStudio.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import { createLessonFixture } from '../../../server/features/guidedLessons/LessonFixture.js';

beforeAll(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
});
afterAll(() => {
  Reflect.deleteProperty(document, 'fonts');
});
beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function createProps(): ComponentProps<typeof TeacherLessonStudio> {
  const fixture = createLessonFixture();
  return {
    userId: 'teacher-1',
    lesson: {
      id: 'lesson-1',
      classId: 'class-1',
      title: fixture.plan.title,
      status: LessonStatus.AWAITING_SCRIPT_APPROVAL,
      version: 1,
      language: 'en',
      updatedAt: '2026-10-09T21:00:00.000Z',
      releaseId: null,
      error: null,
      input: fixture.input,
      plan: fixture.plan,
      contentHash: fixture.record.contentHash,
      review: null,
      visualReview: null,
      manifest: null,
      scriptApproved: false,
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
    },
    preview: null,
    busy: false,
    onSavePlan: vi
      .fn<ComponentProps<typeof TeacherLessonStudio>['onSavePlan']>()
      .mockResolvedValue(),
    onApproveScript: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onRender: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onApprovePreview: vi
      .fn<ComponentProps<typeof TeacherLessonStudio>['onApprovePreview']>()
      .mockResolvedValue(),
    onRelease: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onWithdraw: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onCancel: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onRetry: vi.fn<() => Promise<void>>().mockResolvedValue(),
    onPreviewScene: vi
      .fn<ComponentProps<typeof TeacherLessonStudio>['onPreviewScene']>()
      .mockResolvedValue(),
  };
}

function createStudio(props: ComponentProps<typeof TeacherLessonStudio>) {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(LocaleProvider, {
      children: createElement(TeacherLessonStudio, props),
    }),
  });
}

it('requires opening each script scene before the teacher can attest to a complete review', () => {
  const props = createProps();
  render(createStudio(props));
  const acknowledgment = screen.getByRole('checkbox', {
    name: 'I reviewed the script, sources, hints and worked explanations.',
  });
  expect(acknowledgment).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Approve this script' })).toHaveProperty(
    'disabled',
    true,
  );
  for (const [index, scene] of (props.lesson.plan?.scenes ?? []).entries()) {
    fireEvent.click(screen.getByRole('combobox', { name: 'Scene' }));
    fireEvent.click(screen.getByRole('option', { name: `${String(index + 1)}. ${scene.title}` }));
  }
  expect(acknowledgment).toHaveProperty('disabled', false);
  fireEvent.click(acknowledgment);
  fireEvent.click(screen.getByRole('button', { name: 'Approve this script' }));
  expect(props.onApproveScript).toHaveBeenCalledOnce();
});

it('preserves unsaved edits on a repeated server read, then resets them on a new version', () => {
  const props = createProps();
  const view = render(createStudio(props));
  fireEvent.change(screen.getByRole('textbox', { name: 'Lesson title' }), {
    target: { value: 'An edited title' },
  });
  view.rerender(
    createStudio({
      ...props,
      lesson: { ...props.lesson, plan: props.lesson.plan ? { ...props.lesson.plan } : null },
    }),
  );
  expect(screen.getByRole('textbox', { name: 'Lesson title' })).toHaveProperty(
    'value',
    'An edited title',
  );
  expect(
    screen.getByRole('checkbox', {
      name: 'I reviewed the script, sources, hints and worked explanations.',
    }),
  ).toHaveProperty('disabled', true);
  view.rerender(createStudio({ ...props, lesson: { ...props.lesson, version: 2 } }));
  expect(screen.getByRole('textbox', { name: 'Lesson title' })).toHaveProperty(
    'value',
    props.lesson.plan?.title,
  );
});
