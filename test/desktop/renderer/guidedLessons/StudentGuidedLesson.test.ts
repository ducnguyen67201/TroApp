// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  GuidedLessonAction,
  LearnerProjectionSchema,
  LearnerProgressIntent,
  LessonPhase,
  LessonStatus,
  LessonTemplateKind,
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
import { readLessonDurationFrames } from '../../../../src/lessonMedia/LessonComposition.js';

vi.mock('../../../../src/desktop/renderer/guidedLessons/GuidedLessonMedia.js', () => ({
  GuidedLessonMedia: (props: GuidedLessonMediaProps) =>
    createElement(
      'div',
      { 'data-testid': 'safe-lesson-media', 'data-frame': props.initialFrame },
      createElement('button', { onClick: () => props.onReadyChange?.(true) }, 'Report media ready'),
      createElement(
        'button',
        {
          onClick: () => {
            props.onFrameChange(readLessonDurationFrames(props.projection) - 2);
          },
        },
        'Report penultimate frame',
      ),
      createElement(
        'button',
        {
          onClick: () => {
            props.onFrameChange(readLessonDurationFrames(props.projection) - 1);
          },
        },
        'Report scene end',
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

function createSourceExplanationProps(
  phase: LessonPhase = LessonPhase.WATCH,
): ComponentProps<typeof StudentGuidedLesson> {
  const props = createProps();
  const text = 'Hue names a color family. Brightness describes how light or dark it appears.';
  const projection = LearnerProjectionSchema.parse({
    ...props.playback.projection,
    sceneId: phase === LessonPhase.REFLECT ? 'source-reflection' : 'source-explanation',
    sceneTitle: 'Distinguish hue and brightness',
    lessonPhases: [LessonPhase.WATCH, LessonPhase.REFLECT],
    phase,
    frame: 0,
    presentation: {
      kind: LessonTemplateKind.SOURCE_EXPLANATION,
      templateVersion: '1.0.0',
      layoutVariant: 'standard',
      points: [
        {
          pointId: 'hue-and-brightness',
          text,
          sourceRefs: [{ passageId: 'art-passage', startOffset: 0, endOffset: text.length }],
        },
      ],
    },
    checkpoint: null,
    visibleTraceStates: [],
    visualCues: [],
    narrationCues: [
      {
        cueId: 'source-cue',
        beatId: 'source-beat',
        artifactId: 'source-narration',
        startFrame: 0,
        endFrame: 90,
        text,
        traceEventId: null,
        stateView: null,
      },
    ],
    allowedArtifactIds: ['source-narration'],
  });
  return {
    ...props,
    lesson: { ...props.lesson, title: projection.sceneTitle },
    playback: {
      ...props.playback,
      projection,
      reflectionPrompt: 'How would you distinguish hue from brightness in your own words?',
      notes: [],
    },
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

it('shows the approved lesson phases and omits Try when no practice variant exists', () => {
  renderLesson(createProps());
  const phases = within(screen.getByRole('complementary', { name: 'Lesson phases' }));
  expect(
    phases.getAllByRole('listitem').map((item) => item.querySelector('strong')?.textContent),
  ).toEqual(['Watch', 'Predict', 'Worked answer', 'Reflect']);
  expect(phases.queryByText('Try')).toBeNull();
});

it('shows only Watch and Reflect for a source explanation without Python or quiz controls', () => {
  renderLesson(createSourceExplanationProps());
  const phases = within(screen.getByRole('complementary', { name: 'Lesson phases' }));
  expect(phases.getAllByRole('listitem')).toHaveLength(2);
  expect(phases.getByText('Watch').closest('li')?.getAttribute('aria-current')).toBe('step');
  expect(phases.getByText('Reflect')).toBeTruthy();
  for (const label of ['Predict', 'Worked answer', 'Try']) {
    expect(phases.queryByText(label)).toBeNull();
  }
  expect(screen.queryByRole('textbox', { name: 'Your prediction' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Check answer' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next hint' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show worked answer' })).toBeNull();
  expect(screen.queryByText('This is practice, not a graded examination.')).toBeNull();
});

it('continues a source explanation only after its media is ready and the scene has ended', async () => {
  const props = createSourceExplanationProps();
  renderLesson(props);
  const continueButton = screen.getByRole('button', { name: 'Continue' });
  expect(continueButton).toHaveProperty('disabled', true);
  fireEvent.click(continueButton);
  expect(props.onCommand).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Report scene end' }));
  expect(continueButton).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Report media ready' }));
  expect(continueButton).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Report penultimate frame' }));
  expect(continueButton).toHaveProperty('disabled', true);
  fireEvent.click(continueButton);
  expect(props.onCommand).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Report scene end' }));
  expect(continueButton).toHaveProperty('disabled', false);
  fireEvent.click(continueButton);
  await waitFor(() => {
    expect(props.onCommand).toHaveBeenCalledTimes(1);
  });
  expect(props.onCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      action: GuidedLessonAction.PROGRESS,
      intent: LearnerProgressIntent.WATCH_COMPLETE,
      classId: props.lesson.classId,
      lessonId: props.lesson.id,
      releaseId: props.playback.projection.releaseId,
      expectedProgressVersion: props.playback.projection.progressVersion,
      sceneId: 'source-explanation',
      frame: 89,
      reflection: '',
    }),
  );
});

it('saves the source lesson reflection through the private progress command without a quiz', async () => {
  const props = createSourceExplanationProps(LessonPhase.REFLECT);
  renderLesson(props);
  const phases = within(screen.getByRole('complementary', { name: 'Lesson phases' }));
  expect(phases.getByText('Reflect').closest('li')?.getAttribute('aria-current')).toBe('step');
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Your prediction' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: props.playback.reflectionPrompt }), {
    target: { value: 'Hue identifies the family; brightness can vary within that family.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save private reflection' }));
  await waitFor(() => {
    expect(props.onCommand).toHaveBeenCalledTimes(1);
  });
  expect(props.onCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      action: GuidedLessonAction.PROGRESS,
      intent: LearnerProgressIntent.REFLECT,
      releaseId: props.playback.projection.releaseId,
      expectedProgressVersion: props.playback.projection.progressVersion,
      sceneId: 'source-reflection',
      frame: 0,
      reflection: 'Hue identifies the family; brightness can vary within that family.',
    }),
  );
});

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
