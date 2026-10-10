// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  GuidedLessonAction,
  LearnerProgressIntent,
  LessonStatus,
  type GuidedLessonReply,
} from '#contracts/GuidedLessons.js';
import type { GuidedLessonMediaProps } from '../../../../src/desktop/renderer/guidedLessons/GuidedLessonMedia.js';
import { StudentGuidedLesson } from '../../../../src/desktop/renderer/guidedLessons/StudentGuidedLesson.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import { createLessonPlaybackFixture } from '../../../server/features/guidedLessons/LessonPlaybackFixture.js';

vi.mock('../../../../src/desktop/renderer/guidedLessons/GuidedLessonMedia.js', () => ({
  GuidedLessonMedia: (props: GuidedLessonMediaProps) =>
    createElement('div', { 'data-testid': 'safe-lesson-media', 'data-frame': props.initialFrame }),
}));

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

function createProps(): ComponentProps<typeof StudentGuidedLesson> {
  const fixture = createLessonPlaybackFixture();
  const { projection } = fixture;
  return {
    userId: 'student-1',
    lesson: {
      id: 'lesson-1',
      classId: 'class-1',
      title: fixture.plan.title,
      status: LessonStatus.RELEASED,
      version: 1,
      language: 'en',
      updatedAt: '2026-10-09T21:00:00.000Z',
      releaseId: projection.releaseId,
      error: null,
    },
    playback: {
      kind: 'projection',
      projection,
      reflectionPrompt: fixture.plan.reflectionPrompt,
      notes: [
        {
          noteId: 'private-note',
          expectedVersion: 1,
          anchor: {
            releaseId: projection.releaseId,
            sceneId: projection.sceneId,
            phase: projection.phase,
            frame: 0,
            traceEventId: null,
            sourceRef: null,
          },
          text: 'Private concern never sent to the teacher',
          isBookmark: false,
        },
      ],
    },
    busy: false,
    onCommand: vi
      .fn<ComponentProps<typeof StudentGuidedLesson>['onCommand']>()
      .mockResolvedValue({ kind: 'requests', requests: [] }),
  };
}

function renderLesson(props: ComponentProps<typeof StudentGuidedLesson>) {
  return render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(StudentGuidedLesson, props),
      }),
    }),
  );
}

it('keeps a pending checkpoint held until the server returns an authorized projection', () => {
  const props = createProps();
  renderLesson(props);
  expect(screen.getByRole('textbox', { name: 'Your prediction' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  expect(screen.queryByText('The running total is now two.')).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Your prediction' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
  expect(props.onCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      action: GuidedLessonAction.ATTEMPT,
      checkpointId: 'checkpoint-1',
      expectedProgressVersion: props.playback.projection.progressVersion,
      answer: { kind: 'number', value: 2 },
    }),
  );
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
});

it('sends only explicitly reviewed request text and lesson references', async () => {
  const props = createProps();
  renderLesson(props);
  fireEvent.click(screen.getByRole('button', { name: 'Request another explanation' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'What would you like explained?' }), {
    target: { value: 'Please explain the addition step.' },
  });
  expect(screen.getByRole('button', { name: 'Send request' })).toHaveProperty('disabled', true);
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: 'I reviewed this request. My notes and chat are excluded.',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
  await waitFor(() => {
    expect(props.onCommand).toHaveBeenCalledTimes(1);
  });
  const command = vi.mocked(props.onCommand).mock.calls[0]?.[0];
  if (command?.action !== GuidedLessonAction.REQUEST) {
    throw new Error('Expected a reviewed lesson request');
  }
  const { commandId, ...request } = command;
  expect(commandId).toMatch(/^[0-9a-f-]{36}$/);
  expect(request).toEqual({
    action: GuidedLessonAction.REQUEST,
    classId: 'class-1',
    lessonId: 'lesson-1',
    releaseId: props.playback.projection.releaseId,
    sceneId: 'predict',
    text: 'Please explain the addition step.',
  });
  expect(JSON.stringify(command)).not.toContain('Private concern never sent to the teacher');
});

it('shows the approved stored hint returned by the server', async () => {
  const props = createProps();
  const reply: GuidedLessonReply = {
    kind: 'hint',
    hintId: 'hint-1',
    text: 'Combine the current input with the previous total.',
    sourceRefs: [{ passageId: 'passage-1', startOffset: 0, endOffset: 4 }],
  };
  props.onCommand = vi
    .fn<ComponentProps<typeof StudentGuidedLesson>['onCommand']>()
    .mockResolvedValue(reply);
  renderLesson(props);
  fireEvent.click(screen.getByRole('button', { name: 'Next hint' }));
  await screen.findByText(reply.text);
  expect(props.onCommand).toHaveBeenCalledWith(
    expect.objectContaining({ action: GuidedLessonAction.HINT }),
  );
});

it('restores the owned note through a server command and seeks to its authorized cursor', async () => {
  const props = createProps();
  const note = props.playback.notes[0];
  if (!note) {
    throw new Error('Fixture note is missing');
  }
  props.playback.notes = [{ ...note, anchor: { ...note.anchor, frame: 17 } }];
  props.onCommand = vi
    .fn<ComponentProps<typeof StudentGuidedLesson>['onCommand']>()
    .mockResolvedValue({
      ...props.playback,
      projection: { ...props.playback.projection, frame: 17 },
    });
  renderLesson(props);
  fireEvent.click(screen.getByRole('button', { name: 'Private notebook' }));
  fireEvent.click(screen.getByRole('button', { name: 'Return to this note' }));
  await waitFor(() => {
    expect(screen.getByTestId('safe-lesson-media').getAttribute('data-frame')).toBe('17');
  });
  expect(props.onCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      action: GuidedLessonAction.PROGRESS,
      intent: LearnerProgressIntent.REVISIT,
      noteId: 'private-note',
      sceneId: 'predict',
      frame: 17,
    }),
  );
});

it('supplies bounded prior help exchanges without sending private notes', async () => {
  const props = createProps();
  props.onCommand = vi
    .fn<ComponentProps<typeof StudentGuidedLesson>['onCommand']>()
    .mockResolvedValue({
      kind: 'help',
      result: {
        kind: 'answer',
        text: 'Read the current number first.',
        sourceRefs: [{ passageId: 'passage-1', startOffset: 0, endOffset: 4 }],
      },
    });
  renderLesson(props);
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Your question' }), {
    target: { value: 'Where should I look?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  await screen.findByText('Read the current number first.');
  fireEvent.change(screen.getByRole('textbox', { name: 'Your question' }), {
    target: { value: 'And then?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  expect(props.onCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      action: GuidedLessonAction.HELP,
      message: 'And then?',
      history: [
        { role: 'user', text: 'Where should I look?' },
        { role: 'assistant', text: 'Read the current number first.' },
      ],
    }),
  );
  expect(JSON.stringify(vi.mocked(props.onCommand).mock.calls)).not.toContain(
    'Private concern never sent to the teacher',
  );
});
