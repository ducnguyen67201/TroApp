// @vitest-environment happy-dom
import { createElement } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { usePracticeShortcut } from '../../../../src/desktop/renderer/classroom/UsePracticeShortcut.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';
import { createPracticeCheckpoint } from '../../../server/features/classroom/PracticeFixtures.js';
import type { PracticeShortcutEvent } from '#contracts/PracticeShortcut.js';
import type { TeachingContext } from '#contracts/Classroom.js';
import type { DesktopNavigation } from '../../../../src/desktop/renderer/navigation/UseDesktopNavigation.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness({
  context,
  open,
}: {
  context: TeachingContext;
  open: DesktopNavigation['openClass'];
}) {
  const review = usePracticeShortcut(context, open);
  return createElement('div', null, review?.requestId ?? 'No review');
}

it('scopes global intents to the joined activity and navigates without sending evidence', async () => {
  const context = createTeachingContext();
  context.meeting.phase = 'practice';
  context.activity.practiceCheckpoints = [createPracticeCheckpoint()];
  let receive: (event: PracticeShortcutEvent) => void = () => {};
  const unsubscribe = vi.fn<() => void>();
  const open = vi.fn<DesktopNavigation['openClass']>();
  const controlPractice = vi.fn();
  vi.stubGlobal('tro', {
    readPracticeShortcutAvailable: () => Promise.resolve(true),
    subscribePracticeShortcut: (listener: (event: PracticeShortcutEvent) => void) => {
      receive = listener;
      return unsubscribe;
    },
    controlPractice,
  });
  const mounted = render(createElement(Harness, { context, open }));
  const intent = {
    requestId: crypto.randomUUID(),
    classId: context.meeting.classId,
    participationId: context.participation.id,
    activityId: context.activity.id,
    attemptId: context.attempt.id,
    contextVersion: context.meeting.contextVersion,
  };
  receive({ ...intent, attemptId: crypto.randomUUID() });
  expect(open).not.toHaveBeenCalled();
  receive(intent);
  await screen.findByText(intent.requestId);
  expect(open).toHaveBeenCalledWith(context.meeting.classId, 'activities');
  expect(controlPractice).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(screen.getByText(intent.requestId)).toBeTruthy();
  });
  fireEvent.keyDown(window, { key: 'k', altKey: true });
  expect(open).toHaveBeenCalledOnce();
  mounted.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it.each(['Macintosh', 'Windows'])(
  'uses the %s fallback, ignoring other chords, repeats and closed Practice phases',
  async (platform) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
    const modifiers = platform === 'Macintosh' ? { metaKey: true } : { altKey: true };
    const context = createTeachingContext();
    context.meeting.phase = 'practice';
    context.activity.practiceCheckpoints = [createPracticeCheckpoint()];
    const open = vi.fn<DesktopNavigation['openClass']>();
    vi.stubGlobal('tro', { readPracticeShortcutAvailable: () => Promise.resolve(false) });
    const mounted = render(createElement(Harness, { context, open }));
    await Promise.resolve();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'k', ...modifiers, ctrlKey: true });
    fireEvent.keyDown(window, { key: 'k', ...modifiers, shiftKey: true });
    fireEvent.keyDown(window, { key: 'k', ...modifiers, repeat: true });
    expect(open).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'k', ...modifiers });
    expect(open).toHaveBeenCalledOnce();
    mounted.rerender(
      createElement(Harness, {
        context: { ...context, meeting: { ...context.meeting, phase: 'explanation' } },
        open,
      }),
    );
    fireEvent.keyDown(window, { key: 'k', ...modifiers });
    expect(open).toHaveBeenCalledOnce();
  },
);
