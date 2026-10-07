// @vitest-environment happy-dom
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClassroomPacing, ClassroomPhase } from '#contracts/Classroom.js';
import { TeacherLiveLesson } from '../../../../src/desktop/renderer/classroom/TeacherLiveLesson.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';

afterEach(cleanup);

function createProps(): ComponentProps<typeof TeacherLiveLesson> {
  const context = createTeachingContext();
  return {
    meeting: { ...context.meeting, phase: ClassroomPhase.PRACTICE },
    activities: [
      { id: context.meeting.currentActivityId, title: 'First section' },
      { id: 'second-section', title: 'Second section' },
    ],
    busy: false,
    error: null,
    onUpdate: vi.fn<ComponentProps<typeof TeacherLiveLesson>['onUpdate']>().mockResolvedValue(),
    onEnd: vi.fn<() => void>(),
    t: (english) => english,
  };
}

function createPanel(props: ComponentProps<typeof TeacherLiveLesson>): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(TeacherLiveLesson, props),
  });
}

it('changes the current stage once, blocks duplicate requests, and highlights only confirmed state', async () => {
  const props = createProps();
  let finish: () => void = () => {};
  const onUpdate = vi.fn<ComponentProps<typeof TeacherLiveLesson>['onUpdate']>().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(createPanel({ ...props, onUpdate }));
  const section = within(screen.getByRole('region', { name: 'First section' }));
  fireEvent.click(section.getByRole('button', { name: 'Explanation' }));
  expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
    activityId: props.meeting.currentActivityId,
    phase: ClassroomPhase.EXPLANATION,
    pacing: props.meeting.pacing,
  });
  expect(screen.getByRole('status').textContent).toContain('Updating…');
  expect(section.getByRole('button', { name: 'Practice' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(section.getByRole('button', { name: 'Explanation' }).getAttribute('aria-pressed')).toBe(
    'false',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next section' }));
  expect(onUpdate).toHaveBeenCalledOnce();
  view.rerender(
    createPanel({
      ...props,
      onUpdate,
      meeting: {
        ...props.meeting,
        phase: ClassroomPhase.EXPLANATION,
        contextVersion: props.meeting.contextVersion + 1,
      },
    }),
  );
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(section.getByRole('button', { name: 'Explanation' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.queryByRole('status')).toBeNull();
});

it('advances in one click to explanation, preserves pacing and stops at the last section', async () => {
  const props = createProps();
  const view = render(createPanel(props));
  fireEvent.click(screen.getByRole('button', { name: 'Next section' }));
  expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({
    activityId: 'second-section',
    phase: ClassroomPhase.EXPLANATION,
    pacing: props.meeting.pacing,
  });
  view.rerender(
    createPanel({
      ...props,
      meeting: {
        ...props.meeting,
        currentActivityId: 'second-section',
        phase: ClassroomPhase.EXPLANATION,
      },
    }),
  );
  await waitFor(() => {
    expect(screen.queryByRole('status')).toBeNull();
  });
  expect(screen.getByRole('button', { name: 'Next section' })).toHaveProperty('disabled', true);
  expect(
    within(screen.getByRole('region', { name: 'Second section' }))
      .getByRole('button', { name: 'Explanation' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
});

it('retains the confirmed stage and permits retry after a failed update', async () => {
  const props = createProps();
  const onUpdate = vi
    .fn<ComponentProps<typeof TeacherLiveLesson>['onUpdate']>()
    .mockRejectedValueOnce(new Error('private diagnostic'))
    .mockResolvedValue();
  const view = render(createPanel({ ...props, onUpdate }));
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('private diagnostic')).toBeNull();
  expect(screen.getByRole('button', { name: 'Practice' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(onUpdate).toHaveBeenCalledTimes(2);
  view.rerender(
    createPanel({
      ...props,
      onUpdate,
      meeting: { ...props.meeting, phase: ClassroomPhase.REVIEW },
    }),
  );
  await waitFor(() => {
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

it('offers retry for a refused command even when the bridge returns without throwing', async () => {
  const props = createProps();
  const view = render(createPanel(props));
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  view.rerender(createPanel({ ...props, error: 'Could not update the session.' }));
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  view.rerender(createPanel({ ...props, error: null }));
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

it('localizes stage controls and keeps pacing and ending in the options menu', async () => {
  const props = createProps();
  render(createPanel({ ...props, t: (_english, vietnamese) => vietnamese }));
  expect(screen.getByRole('button', { name: 'Thực hành' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.getByRole('button', { name: 'Phần tiếp theo' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tùy chọn buổi học' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Tự chọn phần học' }));
  expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith({
    activityId: props.meeting.currentActivityId,
    phase: ClassroomPhase.PRACTICE,
    pacing: ClassroomPacing.STUDENT,
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Tùy chọn buổi học' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  fireEvent.click(screen.getByRole('button', { name: 'Tùy chọn buổi học' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Kết thúc buổi học' }));
  expect(props.onEnd).toHaveBeenCalledOnce();
});
