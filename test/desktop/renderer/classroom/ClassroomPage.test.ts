// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  ClassroomFailure,
  type ClassroomCommand,
  type ClassroomHome,
} from '#contracts/Classroom.js';
import type { ClassroomPerson } from '#contracts/ClassroomViewAs.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { ClassroomPage } from '../../../../src/desktop/renderer/classroom/ClassroomPage.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { useDesktopNavigation } from '../../../../src/desktop/renderer/navigation/UseDesktopNavigation.js';
import { ClassView } from '../../../../src/desktop/renderer/navigation/DesktopRoute.js';
import type { DesktopNavigation } from '../../../../src/desktop/renderer/navigation/UseDesktopNavigation.js';

interface PanelProps {
  userId: string;
  send: (command: ClassroomCommand) => Promise<void>;
  navigation: DesktopNavigation;
}
vi.mock('../../../../src/desktop/renderer/classroom/TeacherClassroomPanel.js', () => ({
  TeacherClassroomPanel: ({ userId, send }: PanelProps) =>
    createElement(
      'div',
      {},
      `Teacher classes: ${userId}`,
      createElement(
        'button',
        {
          onClick: () => {
            void send({ kind: 'create-class', name: 'New class' });
          },
        },
        'Create a class',
      ),
    ),
}));
vi.mock('../../../../src/desktop/renderer/classroom/StudentClassroomPanel.js', () => ({
  StudentClassroomPanel: ({ userId, navigation }: PanelProps) =>
    createElement(
      'div',
      {},
      `Student classes: ${userId}`,
      createElement(
        'button',
        {
          onClick: () => {
            navigation.openClass(joinedClassId, ClassView.ACTIVITIES);
          },
        },
        'Open joined class',
      ),
    ),
}));
const joinedClassId = '22222222-2222-4222-8222-222222222222';
const onRoleChange = vi.fn<(role: AccountRole) => void>();
const teacher: ClassroomPerson = {
  id: 'teacher',
  name: 'Teacher One',
  email: 'teacher@example.test',
  role: AccountRole.TEACHER,
};
const student: ClassroomPerson = {
  id: 'student',
  name: 'Student One',
  email: 'student@example.test',
  role: AccountRole.STUDENT,
};

function RoutedPage({ refreshRevision = 0 }: { refreshRevision?: number }): ReactElement {
  return createElement(ClassroomPage, {
    userId: 'admin',
    active: true,
    refreshRevision,
    navigation: useDesktopNavigation(),
    onRoleChange,
  });
}

function page(refreshRevision = 0): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(LocaleProvider, {
      children: createElement(RoutedPage, { refreshRevision }),
    }),
  });
}

function home(
  role: AccountRole,
  isAdmin: boolean,
  viewingAs: ClassroomPerson | null = null,
): ClassroomHome {
  return { isAdmin, role, courses: [], classes: [], viewingAs };
}

function teacherClasses(userId: string): ClassroomHome['classes'] {
  return [
    {
      schoolClass: {
        id: '11111111-1111-4111-8111-111111111111',
        teacherId: userId,
        name: 'Teaching class',
        courseRevisionId: '33333333-3333-4333-8333-333333333333',
      },
      meetings: [],
    },
    {
      schoolClass: {
        id: joinedClassId,
        teacherId: 'another-teacher',
        name: 'Joined class',
        courseRevisionId: '33333333-3333-4333-8333-333333333333',
      },
      meetings: [],
    },
  ];
}

beforeEach(() => {
  window.location.hash = '#/classroom';
  window.localStorage.setItem('tro.desktop.locale', 'en');
  onRoleChange.mockClear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([AccountRole.STUDENT, AccountRole.TEACHER])(
  'hides the person picker for ordinary %s accounts',
  async (role) => {
    const send = vi
      .fn<NonNullable<DesktopBridge['controlClassroom']>>()
      .mockImplementation((command) =>
        Promise.resolve(
          command.kind === 'home' ? { kind: 'home', home: home(role, false) } : { kind: 'ok' },
        ),
      );
    vi.stubGlobal('tro', { controlClassroom: send });
    render(page());
    await screen.findByText(
      `${role === AccountRole.TEACHER ? 'Teacher' : 'Student'} classes: admin`,
    );
    expect(screen.queryByRole('button', { name: /View as/ })).toBeNull();
    expect(send.mock.calls.some(([command]) => command.kind.startsWith('admin-'))).toBe(false);
  },
);

it('refreshes classroom permissions after a Settings team change', async () => {
  let role: AccountRole = AccountRole.STUDENT;
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'home' ? { kind: 'home', home: home(role, false) } : { kind: 'ok' },
      ),
    );
  vi.stubGlobal('tro', { controlClassroom: send });
  const view = render(page());
  await screen.findByText('Student classes: admin');
  role = AccountRole.TEACHER;
  view.rerender(page(1));
  await screen.findByText('Teacher classes: admin');
  expect(onRoleChange).toHaveBeenLastCalledWith(AccountRole.TEACHER);
});

it('switches existing teacher and student screens, permits actions, and returns to the admin', async () => {
  let selected: ClassroomPerson | null = null;
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) => {
      if (command.kind === 'home') {
        return Promise.resolve({
          kind: 'home',
          home: {
            ...home(selected?.role ?? AccountRole.STUDENT, true, selected),
            classes: selected?.role === AccountRole.TEACHER ? teacherClasses(selected.id) : [],
          },
        });
      }
      if (command.kind === 'admin-people') {
        return Promise.resolve({
          kind: 'admin-people',
          people: [teacher, student],
          hasMore: false,
        });
      }
      if (command.kind === 'admin-view-as') {
        selected =
          command.userId === teacher.id ? teacher : command.userId === student.id ? student : null;
        return Promise.resolve({ kind: 'admin-view-as', person: selected });
      }
      return Promise.resolve({ kind: 'ok' });
    });
  vi.stubGlobal('tro', { controlClassroom: send });
  render(page());
  fireEvent.click(await screen.findByRole('button', { name: 'View as: Me' }));
  fireEvent.click(await screen.findByRole('button', { name: /Teacher One · Teacher/ }));
  await screen.findByText('Teacher classes: teacher');
  expect(screen.queryByText('Student classes: teacher')).toBeNull();
  expect(screen.queryByText('Student classes: admin')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Classes for Teacher One' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create a class' }));
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith({ kind: 'create-class', name: 'New class' });
  });
  fireEvent.click(screen.getByRole('combobox', { name: 'Class list' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Classes joined' }));
  await screen.findByText('Student classes: teacher');
  expect(screen.queryByText('Teacher classes: teacher')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open joined class' }));
  expect(window.location.hash).toBe(`#/classroom/${joinedClassId}/activities`);
  expect(screen.queryByText('Teacher classes: teacher')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All classes' }));
  expect(screen.getByRole('combobox', { name: 'Class list' }).getAttribute('value')).toBe(
    'Classes joined',
  );
  fireEvent.click(screen.getByRole('button', { name: 'View as: Teacher One' }));
  fireEvent.click(await screen.findByRole('button', { name: /Student One · Student/ }));
  await screen.findByText('Student classes: student');
  expect(screen.queryByText('Student classes: teacher')).toBeNull();
  expect(screen.queryByText('Teacher classes: teacher')).toBeNull();
  expect(onRoleChange.mock.calls.every(([role]) => role === AccountRole.STUDENT)).toBe(true);
  let lastSelection = -1;
  send.mock.calls.forEach(([command], index) => {
    if (command.kind === 'admin-view-as') {
      lastSelection = index;
    }
  });
  expect(
    send.mock.calls.slice(lastSelection + 1).some(([command]) => command.kind === 'resume'),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'View as: Student One' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Return to my account' }));
  await screen.findByText('Student classes: admin');
  fireEvent.click(screen.getByRole('button', { name: 'View as: Me' }));
  fireEvent.click(await screen.findByRole('button', { name: /Teacher One · Teacher/ }));
  await screen.findByText('Teacher classes: teacher');
  expect(screen.queryByText('Student classes: teacher')).toBeNull();
});

it('opens an enrolled teacher class deep link in a single student panel and preserves its list on return', async () => {
  window.location.hash = `#/classroom/${joinedClassId}/activities`;
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'home'
          ? {
              kind: 'home',
              home: { ...home(AccountRole.TEACHER, false), classes: teacherClasses('admin') },
            }
          : { kind: 'ok' },
      ),
    );
  vi.stubGlobal('tro', { controlClassroom: send });
  render(page());
  await screen.findByText('Student classes: admin');
  expect(screen.queryByText('Teacher classes: admin')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All classes' }));
  expect(screen.queryByText('Teacher classes: admin')).toBeNull();
  fireEvent.click(screen.getByRole('combobox', { name: 'Class list' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Classes taught' }));
  await screen.findByText('Teacher classes: admin');
  expect(screen.queryByText('Student classes: admin')).toBeNull();
});

it('clears selected data after access is revoked and still allows returning to self', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  let selected: ClassroomPerson | null = null;
  let revoked = false;
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) => {
      if (command.kind === 'home') {
        return Promise.resolve(
          revoked && selected
            ? { kind: 'failed', code: ClassroomFailure.FORBIDDEN }
            : {
                kind: 'home',
                home: home(selected?.role ?? AccountRole.STUDENT, !revoked, selected),
              },
        );
      }
      if (command.kind === 'admin-people') {
        return Promise.resolve({ kind: 'admin-people', people: [teacher], hasMore: false });
      }
      if (command.kind === 'admin-view-as') {
        selected = command.userId ? teacher : null;
        return Promise.resolve({ kind: 'admin-view-as', person: selected });
      }
      return Promise.resolve({ kind: 'ok' });
    });
  vi.stubGlobal('tro', { controlClassroom: send });
  render(page());
  fireEvent.click(await screen.findByRole('button', { name: 'View as: Me' }));
  fireEvent.click(await screen.findByRole('button', { name: /Teacher One · Teacher/ }));
  await screen.findByText('Teacher classes: teacher');
  revoked = true;
  const refresh = [...intervals.mock.calls].reverse().find(([, delay]) => delay === 10_000)?.[0];
  await act(async () => {
    if (typeof refresh === 'function') {
      refresh();
    }
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.queryByText('Teacher classes: teacher')).toBeNull();
  });
  fireEvent.click(screen.getByRole('button', { name: 'View as: Teacher One' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Return to my account' }));
  await screen.findByText('Student classes: admin');
  expect(screen.queryByRole('button', { name: /View as/ })).toBeNull();
});

it('uses the enrolled screen when a retained teacher assignment has no current teaching authority', async () => {
  const classes = teacherClasses('admin').map((entry) => ({
    ...entry,
    canTeach: entry.schoolClass.id !== joinedClassId,
    schoolClass: { ...entry.schoolClass, teacherId: 'admin' },
  }));
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) =>
      Promise.resolve(
        command.kind === 'home'
          ? { kind: 'home', home: { ...home(AccountRole.TEACHER, false), classes } }
          : { kind: 'ok' },
      ),
    );
  vi.stubGlobal('tro', { controlClassroom: send });
  window.location.hash = `#/classroom/${joinedClassId}/activities`;
  render(page());
  await screen.findByText('Student classes: admin');
  expect(screen.queryByText('Teacher classes: admin')).toBeNull();
});
