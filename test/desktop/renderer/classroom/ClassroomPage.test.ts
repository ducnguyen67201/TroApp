// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { type ClassroomCommand, type ClassroomHome } from '#contracts/Classroom.js';
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

function home(role: AccountRole, isAdmin: boolean): ClassroomHome {
  return { isAdmin, role, courses: [], classes: [] };
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
  'has no impersonation controls for %s accounts, including admins',
  async (role) => {
    const send = vi
      .fn<NonNullable<DesktopBridge['controlClassroom']>>()
      .mockImplementation((command) =>
        Promise.resolve(
          command.kind === 'home' ? { kind: 'home', home: home(role, true) } : { kind: 'ok' },
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
