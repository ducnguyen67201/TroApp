// @vitest-environment happy-dom
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  ClassroomStatus,
  type ClassroomCommand,
  type ClassroomHome,
  type TeachingContext,
} from '#contracts/Classroom.js';
import { StudentClassroomPanel } from '../../../../src/desktop/renderer/classroom/StudentClassroomPanel.js';
import { useDesktopNavigation } from '../../../../src/desktop/renderer/navigation/UseDesktopNavigation.js';
import { StudentActivityPanel } from '../../../../src/desktop/renderer/classroom/StudentActivityPanel.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';

afterEach(cleanup);

function RoutedStudentPanel(props: ComponentProps<typeof StudentClassroomPanel>): ReactElement {
  return createElement(StudentClassroomPanel, { ...props, navigation: useDesktopNavigation() });
}

it('opens the student class route without joining and returns to the list', () => {
  window.location.hash = '#/classroom';
  const context = createTeachingContext();
  const send = vi.fn<(command: ClassroomCommand) => Promise<void>>().mockResolvedValue();
  render(
    createElement(MantineProvider, {
      children: createElement(RoutedStudentPanel, {
        home: createHome(context),
        userId: 'student',
        context: null,
        search: '',
        busy: false,
        send,
        preparation: null,
        receipt: null,
        t: (english) => english,
      }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: new RegExp(context.className) }));
  expect(window.location.hash).toBe(`#/classroom/${context.meeting.classId}/activities`);
  expect(screen.queryByRole('tab', { name: 'Your classes' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Class settings' })).toBeNull();
  expect(send).not.toHaveBeenCalled();
  act(() => {
    window.location.hash = '#/classroom';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(window.location.hash).toBe('#/classroom');
  expect(screen.getByRole('button', { name: new RegExp(context.className) })).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
});

function createHome(context: TeachingContext): ClassroomHome {
  return {
    role: AccountRole.STUDENT,
    courses: [
      {
        id: context.courseRevisionId,
        title: 'Scratch lesson',
        activities: context.availableActivities,
      },
    ],
    classes: [
      {
        schoolClass: {
          id: context.meeting.classId,
          teacherId: 'teacher',
          name: context.className,
          courseRevisionId: context.courseRevisionId,
        },
        meetings: [context.meeting],
      },
    ],
  };
}

it('browses enrolled classes without joining until the student explicitly joins the session', () => {
  const context = createTeachingContext();
  const send = vi.fn<(command: ClassroomCommand) => Promise<void>>().mockResolvedValue();
  render(
    createElement(MantineProvider, {
      children: createElement(StudentClassroomPanel, {
        home: createHome(context),
        userId: 'student',
        context: null,
        search: '',
        busy: false,
        send,
        preparation: null,
        receipt: null,
        t: (english) => english,
      }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: new RegExp(context.className) }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Join session' }));
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'join', classSessionId: context.meeting.id }),
  );
});

it('opens materials and navigates to help without mutating the existing session', () => {
  const context = createTeachingContext();
  const send = vi.fn<(command: ClassroomCommand) => Promise<void>>().mockResolvedValue();
  const onAskForHelp = vi.fn<() => void>();
  render(
    createElement(MantineProvider, {
      children: createElement(StudentClassroomPanel, {
        home: createHome(context),
        userId: 'student',
        context,
        search: '',
        busy: false,
        send,
        preparation: null,
        receipt: null,
        t: (english) => english,
        onAskForHelp,
      }),
    }),
  );
  expect(screen.getByText(context.activity.instructions)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Materials for this session' }));
  expect(screen.getByRole('tab', { name: 'Materials' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Ask Tro for a hint' }));
  expect(onAskForHelp).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});

it('keeps hand-in as separate preparation and explicit confirmation with the existing version binding', () => {
  const base = createTeachingContext();
  const context = {
    ...base,
    attempt: { ...base.attempt, workspaceUrl: 'https://scratch.mit.edu/projects/123456/' },
  };
  const send = vi.fn<(command: ClassroomCommand) => Promise<void>>().mockResolvedValue();
  const props = {
    context,
    busy: false,
    send,
    receipt: null,
    t: (english: string) => english,
    onShowMaterials: () => {},
  };
  const view = render(
    createElement(MantineProvider, {
      children: createElement(StudentActivityPanel, { ...props, preparation: null }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review hand-in' }));
  expect(send).toHaveBeenLastCalledWith({
    kind: 'prepare-submission',
    participationId: context.participation.id,
    deviceId: context.participation.deviceId,
    activityId: context.activity.id,
    contextVersion: context.meeting.contextVersion,
    progressVersion: context.attempt.progressVersion,
  });
  expect(screen.queryByRole('button', { name: 'Submit this project' })).toBeNull();
  const preparation = {
    kind: 'prepared' as const,
    preparation: {
      id: crypto.randomUUID(),
      attemptId: context.attempt.id,
      url: context.attempt.workspaceUrl,
      progressVersion: context.attempt.progressVersion,
      contextVersion: context.meeting.contextVersion,
      expiresAt: new Date().toISOString(),
    },
  };
  view.rerender(
    createElement(MantineProvider, {
      children: createElement(StudentActivityPanel, { ...props, preparation }),
    }),
  );
  const confirmation = screen.getByRole('alert');
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Submit this project' }));
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'submit-work',
      preparedSubmissionId: preparation.preparation.id,
      idempotencyKey: preparation.preparation.id,
      contextVersion: context.meeting.contextVersion,
      progressVersion: context.attempt.progressVersion,
    }),
  );
});

it.each([false, true])(
  'updates session availability on refresh without joining automatically (Vietnamese: %s)',
  (vietnamese) => {
    const context = createTeachingContext();
    const send = vi.fn<(command: ClassroomCommand) => Promise<void>>().mockResolvedValue();
    const liveLabel = vietnamese ? 'Đang diễn ra' : 'Live now';
    const waitingLabel = vietnamese ? 'Chờ bắt đầu' : 'Waiting to start';
    const props = {
      home: createHome(context),
      userId: 'student',
      context: null,
      search: '',
      busy: false,
      send,
      preparation: null,
      receipt: null,
      t: (english: string, translated: string) => (vietnamese ? translated : english),
    } satisfies ComponentProps<typeof StudentClassroomPanel>;
    const createPanel = (values: ComponentProps<typeof StudentClassroomPanel>): ReactElement =>
      createElement(MantineProvider, {
        children: createElement(StudentClassroomPanel, values),
      });
    const view = render(createPanel(props));
    const card = screen.getByRole('button', { name: new RegExp(context.className) });
    const details = screen.getByRole('complementary');
    expect(within(card).getByText(liveLabel)).toBeTruthy();
    expect(within(details).getByText(liveLabel)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();

    view.rerender(createPanel({ ...props, context }));
    expect(within(details).getByText(liveLabel)).toBeTruthy();
    const endedHome: ClassroomHome = {
      ...props.home,
      classes: props.home.classes.map((entry) => ({
        ...entry,
        meetings: entry.meetings.map((meeting) => ({ ...meeting, status: ClassroomStatus.ENDED })),
      })),
    };
    view.rerender(createPanel({ ...props, home: endedHome }));
    expect(screen.queryByText(liveLabel)).toBeNull();
    expect(within(card).getByText(waitingLabel)).toBeTruthy();
    expect(within(details).getByText(waitingLabel)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: vietnamese ? 'Vào buổi học' : 'Join session' }),
    ).toBeNull();
    expect(send).not.toHaveBeenCalled();
  },
);
