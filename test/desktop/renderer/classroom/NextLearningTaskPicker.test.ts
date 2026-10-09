// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { createElement, type ComponentProps } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NextLearningTaskPicker } from '../../../../src/desktop/renderer/classroom/NextLearningTaskPicker.js';
import { createStudentProgress } from '../../ClassroomInsightDesktopFixtures.js';

afterEach(cleanup);

it.each([true, false])(
  'shows the captured next-task title when current activity metadata is missing: %s',
  (missing) => {
    const activityId = randomUUID();
    const courseRevisionId = randomUUID();
    const progress = {
      ...createStudentProgress(),
      nextTask: {
        id: randomUUID(),
        version: 1,
        sourceRevision: '4',
        studentId: 'minh',
        activityId,
        courseRevisionId,
        title: 'Trace a different loop',
        selectedBy: 'teacher',
        selectedAt: '2026-10-08T16:00:00.000Z',
        sourceIds: [],
      },
    };
    const send = vi.fn<ComponentProps<typeof NextLearningTaskPicker>['send']>();
    render(
      createElement(MantineProvider, {
        env: 'test',
        children: createElement(NextLearningTaskPicker, {
          progress,
          activities: missing
            ? []
            : [{ id: activityId, courseRevisionId, title: 'Renamed activity', criteria: [] }],
          teacher: false,
          send,
          onSaved: () => {},
        }),
      }),
    );
    expect(screen.getByText('Trace a different loop')).toBeTruthy();
    expect(screen.queryByText('Renamed activity')).toBeNull();
    expect(
      screen.queryByText('Your teacher can choose the next activity after reviewing your work.'),
    ).toBeNull();
    expect(send).not.toHaveBeenCalled();
  },
);

it('keeps a legacy next-task selection visible when its title and current activity are unavailable', () => {
  const progress = {
    ...createStudentProgress(),
    nextTask: {
      id: randomUUID(),
      version: 1,
      sourceRevision: '4',
      studentId: 'minh',
      activityId: randomUUID(),
      courseRevisionId: randomUUID(),
      selectedBy: 'teacher',
      selectedAt: '2026-10-08T16:00:00.000Z',
      sourceIds: [],
    },
  };
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(NextLearningTaskPicker, {
        progress,
        activities: [],
        teacher: false,
        send: vi.fn<ComponentProps<typeof NextLearningTaskPicker>['send']>(),
        onSaved: () => {},
      }),
    }),
  );
  expect(screen.getByText('Teacher-selected activity')).toBeTruthy();
  expect(screen.getByText('Task details are unavailable.')).toBeTruthy();
});
