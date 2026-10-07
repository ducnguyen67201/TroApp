// @vitest-environment happy-dom
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  ClassroomPacing,
  ClassroomPhase,
  ClassroomStatus,
  type ClassroomCommand,
  type ClassroomHome,
} from '#contracts/Classroom.js';
import { useDesktopNavigation } from '../../../../src/desktop/renderer/navigation/UseDesktopNavigation.js';
import { TeacherClassroomPanel } from '../../../../src/desktop/renderer/classroom/TeacherClassroomPanel.js';

vi.mock('../../../../src/desktop/renderer/classroom/MaterialEditor.js', () => ({
  MaterialEditor: () => null,
}));

const classId = '11111111-1111-4111-8111-111111111111';
const secondClassId = '22222222-2222-4222-8222-222222222222';
const courseId = '33333333-3333-4333-8333-333333333333';
const firstActivityId = '44444444-4444-4444-8444-444444444444';
const secondActivityId = '55555555-5555-4555-8555-555555555555';
const meetingId = '66666666-6666-4666-8666-666666666666';

function createHome(isLive = false): ClassroomHome {
  return {
    role: AccountRole.TEACHER,
    courses: [
      {
        id: courseId,
        title: 'Build and share',
        activities: [
          { id: firstActivityId, title: 'Build the project' },
          { id: secondActivityId, title: 'Share the project' },
        ],
      },
    ],
    classes: [
      {
        schoolClass: {
          id: classId,
          teacherId: 'teacher',
          name: 'Class A',
          courseRevisionId: courseId,
        },
        meetings: isLive
          ? [
              {
                id: meetingId,
                classId,
                status: ClassroomStatus.LIVE,
                phase: ClassroomPhase.PRACTICE,
                pacing: ClassroomPacing.TEACHER,
                currentActivityId: firstActivityId,
                contextVersion: 7,
              },
            ]
          : [],
      },
      {
        schoolClass: {
          id: secondClassId,
          teacherId: 'teacher',
          name: 'Class B',
          courseRevisionId: courseId,
        },
        meetings: [],
      },
      {
        schoolClass: {
          id: crypto.randomUUID(),
          teacherId: 'other-teacher',
          name: 'Another teacher’s class',
          courseRevisionId: courseId,
        },
        meetings: [],
      },
    ],
  };
}

function createProps(home: ClassroomHome) {
  return {
    home,
    userId: 'teacher',
    busy: false,
    send: vi.fn<(command: ClassroomCommand) => Promise<void>>().mockResolvedValue(),
    roster: null,
    onClassChange: vi.fn<() => void>(),
    invitation: null,
    t: (english: string) => english,
    refresh: vi.fn<() => Promise<void>>().mockResolvedValue(),
  } satisfies Omit<ComponentProps<typeof TeacherClassroomPanel>, 'navigation'>;
}

function RoutedTeacherPanel(
  props: Omit<ComponentProps<typeof TeacherClassroomPanel>, 'navigation'>,
): ReactElement {
  return createElement(TeacherClassroomPanel, { ...props, navigation: useDesktopNavigation() });
}

function createPanel(
  props: Omit<ComponentProps<typeof TeacherClassroomPanel>, 'navigation'>,
): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(RoutedTeacherPanel, props),
  });
}

beforeEach(() => {
  window.location.hash = '#/classroom';
});

afterEach(() => {
  cleanup();
});

describe('teacher classroom cards', () => {
  it('returns inaccessible class routes to the list without exposing management actions', () => {
    window.location.hash = '#/classroom/99999999-9999-4999-8999-999999999999/settings';
    const props = createProps(createHome());
    render(createPanel(props));
    expect(window.location.hash).toBe('#/classroom');
    expect(screen.queryByRole('button', { name: 'Add student' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete class' })).toBeNull();
    expect(props.send).not.toHaveBeenCalled();
  });

  it('opens the class form from the tab toolbar without creating until submission', async () => {
    const props = createProps(createHome());
    render(createPanel(props));
    fireEvent.click(screen.getByRole('button', { name: 'Create a class' }));
    const dialog = screen.getByRole('dialog', { name: 'Create a class' });
    expect(within(dialog).getByRole('button', { name: 'Create class' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Class name' }), {
      target: { value: 'Python beginners' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(props.send).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create a class' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Create class' }),
    );
    await waitFor(() => {
      expect(props.send).toHaveBeenCalledExactlyOnceWith({
        kind: 'create-class',
        name: 'Python beginners',
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('requires deletion confirmation and resets it when the selected class changes', () => {
    const props = createProps(createHome());
    render(createPanel(props));
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class A' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Class settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete class' }));
    expect(props.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm delete class' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete class' }));
    act(() => {
      window.location.hash = '#/classroom';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class B' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Class settings' }));
    expect(screen.queryByRole('button', { name: 'Confirm delete class' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete class' }));
    expect(props.send).toHaveBeenCalledExactlyOnceWith({
      kind: 'delete-class',
      classId: secondClassId,
    });
  });

  it('keeps deletion disabled while a class has a live session', () => {
    const props = createProps(createHome(true));
    render(createPanel(props));
    expect(
      within(screen.getByRole('button', { name: 'Manage Class A' })).getByText('Live now'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: 'Manage Class B' })).getByText('Waiting to start'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('complementary', { name: 'Class details' })).getByText('Live now'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class A' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Class settings' }));
    expect(screen.getByRole('button', { name: 'Delete class' })).toHaveProperty('disabled', true);
    expect(screen.getByText('End the live session before deleting this class.')).toBeTruthy();
    expect(props.send).not.toHaveBeenCalled();
  });

  it('opens an owned class route without a command and keeps management in settings', () => {
    const props = createProps(createHome());
    const view = render(createPanel(props));
    expect(
      screen.getByRole('button', { name: 'Manage Class A' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.queryByRole('button', { name: 'Manage Another teacher’s class' })).toBeNull();
    expect(props.send).not.toHaveBeenCalled();
    view.rerender(createPanel({ ...props, search: 'CLASS B' }));
    expect(screen.queryByRole('button', { name: 'Manage Class A' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage Class B' })).toBeTruthy();
    expect(
      within(screen.getByRole('complementary', { name: 'Class details' })).getByRole('heading', {
        name: 'Class A',
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class B' }));
    expect(
      within(screen.getByRole('complementary', { name: 'Class details' })).getByRole('heading', {
        name: 'Class B',
      }),
    ).toBeTruthy();
    expect(window.location.hash).toBe(`#/classroom/${secondClassId}`);
    expect(screen.queryByRole('button', { name: 'Manage Class A' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete class' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Class settings' }));
    expect(window.location.hash).toBe(`#/classroom/${secondClassId}/settings`);
    expect(screen.getByRole('button', { name: 'Delete class' })).toBeTruthy();
    expect(props.onClassChange).toHaveBeenCalledOnce();
    expect(props.send).not.toHaveBeenCalled();
  });

  it('reconciles a removed class and keeps section selection usable across classes sharing a course', async () => {
    const home = createHome();
    const props = createProps(home);
    const view = render(createPanel(props));
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class B' }));
    expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty('disabled', false);
    view.rerender(
      createPanel({
        ...props,
        home: {
          ...home,
          classes: home.classes.filter((entry) => entry.schoolClass.id !== secondClassId),
        },
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Manage Class A' }).getAttribute('aria-pressed'),
      ).toBe('true');
    });
    expect(window.location.hash).toBe('#/classroom');
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class A' }));
    expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty('disabled', false);
    expect(props.onClassChange).toHaveBeenCalledTimes(2);
    expect(props.send).not.toHaveBeenCalled();
  });

  it('keeps invitations and chosen-section session commands scoped to the selected class', () => {
    const props = createProps(createHome());
    render(createPanel(props));
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class A' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Class settings' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Student email' }), {
      target: { value: ' student@example.test ' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Add student' }));
    expect(props.send).toHaveBeenLastCalledWith({
      kind: 'enroll',
      classId,
      email: 'student@example.test',
    });
    fireEvent.click(screen.getByText('Share an invitation code instead', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation code' }));
    expect(props.send).toHaveBeenLastCalledWith({ kind: 'create-invitation', classId });
    fireEvent.click(screen.getByRole('button', { name: 'Disable existing codes' }));
    expect(props.send).toHaveBeenLastCalledWith({ kind: 'revoke-invitations', classId });
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('button', { name: /Share the project/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(props.send).toHaveBeenLastCalledWith({
      kind: 'start-session',
      classId,
      activityId: secondActivityId,
      pacing: ClassroomPacing.TEACHER,
    });
  });

  it('jumps to a section in two clicks and applies pacing from the options menu immediately', async () => {
    const props = createProps(createHome(true));
    render(createPanel(props));
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class A' }));
    const controls = within(screen.getByRole('region', { name: 'Live lesson controls' }));
    const current = within(screen.getByRole('region', { name: 'Build the project' }));
    expect(current.getByRole('button', { name: 'Practice' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByRole('complementary', { name: 'Class details' })).toBeNull();
    fireEvent.click(controls.getByRole('button', { name: /Share the project/ }));
    expect(props.send).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Share the project' })).getByRole('button', {
        name: 'Practice',
      }),
    );
    expect(props.send).toHaveBeenCalledExactlyOnceWith({
      kind: 'update-session',
      classSessionId: meetingId,
      contextVersion: 7,
      activityId: secondActivityId,
      phase: ClassroomPhase.PRACTICE,
      pacing: ClassroomPacing.TEACHER,
    });
    await waitFor(() => {
      expect(controls.getByRole('button', { name: 'Session options' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    fireEvent.click(controls.getByRole('button', { name: 'Session options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Self-paced' }));
    expect(props.send).toHaveBeenLastCalledWith({
      kind: 'update-session',
      classSessionId: meetingId,
      contextVersion: 7,
      activityId: firstActivityId,
      phase: ClassroomPhase.PRACTICE,
      pacing: ClassroomPacing.STUDENT,
    });
  });

  it('retries a refused stage change with the latest confirmed session version', async () => {
    const props = createProps(createHome(true));
    const view = render(createPanel(props));
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(props.send).toHaveBeenLastCalledWith(expect.objectContaining({ contextVersion: 7 }));
    view.rerender(
      createPanel({
        ...props,
        error: 'Could not update the session.',
        home: {
          ...props.home,
          classes: props.home.classes.map((entry) => ({
            ...entry,
            meetings: entry.meetings.map((meeting) => ({ ...meeting, contextVersion: 8 })),
          })),
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(props.send).toHaveBeenLastCalledWith({
      kind: 'update-session',
      classSessionId: meetingId,
      contextVersion: 8,
      activityId: firstActivityId,
      phase: ClassroomPhase.REVIEW,
      pacing: ClassroomPacing.TEACHER,
    });
  });

  it('preserves session versions, roster requests and enrollment removal', async () => {
    const props = createProps(createHome(true));
    render(
      createPanel({
        ...props,
        roster: [
          {
            studentId: 'student',
            name: 'A student',
            participation: null,
            attempts: [],
            submissions: [],
          },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manage Class A' }));
    expect(screen.getByText('Not joined')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Student status' }));
    expect(props.send).toHaveBeenLastCalledWith({
      kind: 'session-roster',
      classSessionId: meetingId,
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Class settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove enrollment' }));
    expect(props.send).toHaveBeenLastCalledWith({ kind: 'revoke', classId, studentId: 'student' });
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(props.send).toHaveBeenLastCalledWith({
      kind: 'update-session',
      classSessionId: meetingId,
      contextVersion: 7,
      activityId: firstActivityId,
      phase: ClassroomPhase.REVIEW,
      pacing: ClassroomPacing.TEACHER,
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Session options' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Session options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'End session' }));
    expect(props.send).toHaveBeenLastCalledWith({
      kind: 'end-session',
      classSessionId: meetingId,
      contextVersion: 7,
    });
  });
});
