// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { ClassroomFailure, type ClassroomHome } from '#contracts/Classroom.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { ClassroomPage } from '../../../../src/desktop/renderer/classroom/ClassroomPage.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { useDesktopNavigation } from '../../../../src/desktop/renderer/navigation/UseDesktopNavigation.js';
import { createAdminClassDetail, createAdminClassSummary } from './AdminClassroomFixtures.js';

vi.mock('../../../../src/desktop/renderer/classroom/TeacherClassroomPanel.js', () => ({
  TeacherClassroomPanel: () => createElement('div', {}, 'Own teacher classes'),
}));

vi.mock('../../../../src/desktop/renderer/classroom/StudentClassroomPanel.js', () => ({
  StudentClassroomPanel: () => createElement('div', {}, 'Own student classes'),
}));

const onRoleChange = vi.fn<(role: AccountRole) => void>();

function RoutedClassroomPage(): ReactElement {
  return createElement(ClassroomPage, {
    userId: 'signed-in-user',
    active: true,
    navigation: useDesktopNavigation(),
    onRoleChange,
  });
}

function page(): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(LocaleProvider, { children: createElement(RoutedClassroomPage) }),
  });
}

function createHome(isAdmin: boolean, role: AccountRole): ClassroomHome {
  return { isAdmin, role, courses: [], classes: [] };
}

beforeEach(() => {
  window.location.hash = '#/classroom';
  window.localStorage.setItem('tro.desktop.locale', 'en');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([AccountRole.STUDENT, AccountRole.TEACHER])(
  'keeps admin browsing unavailable to an ordinary %s',
  async (role) => {
    const send = vi
      .fn<NonNullable<DesktopBridge['controlClassroom']>>()
      .mockImplementation((command) =>
        Promise.resolve(
          command.kind === 'home'
            ? { kind: 'home', home: createHome(false, role) }
            : { kind: 'ok' },
        ),
      );
    vi.stubGlobal('tro', { controlClassroom: send });
    render(page());
    expect(
      await screen.findByText(
        role === AccountRole.TEACHER ? 'Own teacher classes' : 'Own student classes',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Admin view' })).toBeNull();
    expect(screen.queryByText('Read-only admin view')).toBeNull();
    expect(
      send.mock.calls.some(
        ([command]) => command.kind === 'admin-classes' || command.kind === 'admin-class',
      ),
    ).toBe(false);
  },
);

it.each([AccountRole.STUDENT, AccountRole.TEACHER])(
  'lets an admin %s view another class and return to their own classes',
  async (role) => {
    const send = vi
      .fn<NonNullable<DesktopBridge['controlClassroom']>>()
      .mockImplementation((command) => {
        if (command.kind === 'home') {
          return Promise.resolve({ kind: 'home', home: createHome(true, role) });
        }
        if (command.kind === 'admin-classes') {
          return Promise.resolve({
            kind: 'admin-classes',
            classes: [createAdminClassSummary()],
            hasMore: false,
          });
        }
        if (command.kind === 'admin-class') {
          return Promise.resolve({ kind: 'admin-class', ...createAdminClassDetail() });
        }
        return Promise.resolve({ kind: 'ok' });
      });
    vi.stubGlobal('tro', { controlClassroom: send });
    render(page());
    fireEvent.click(await screen.findByRole('button', { name: 'Admin view' }));
    expect(await screen.findByText('Class A student current')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join class' })).toBeNull();
    expect(screen.queryByText('Own teacher classes')).toBeNull();
    expect(screen.queryByText('Own student classes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'My classes' }));
    expect(screen.queryByText('Class A student current')).toBeNull();
    expect(
      screen.getByText(
        role === AccountRole.TEACHER ? 'Own teacher classes' : 'Own student classes',
      ),
    ).toBeTruthy();
    expect(
      send.mock.calls.every(([command]) =>
        ['home', 'resume', 'admin-classes', 'admin-class'].includes(command.kind),
      ),
    ).toBe(true);
  },
);

it.each(['revoked', 'unavailable'] as const)(
  'clears the admin view when the periodic home check reports %s',
  async (outcome) => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    let changed = false;
    const send = vi
      .fn<NonNullable<DesktopBridge['controlClassroom']>>()
      .mockImplementation((command) => {
        if (command.kind === 'home') {
          return Promise.resolve(
            changed && outcome === 'unavailable'
              ? { kind: 'failed', code: ClassroomFailure.UNAVAILABLE }
              : { kind: 'home', home: createHome(!changed, AccountRole.STUDENT) },
          );
        }
        if (command.kind === 'admin-classes') {
          return Promise.resolve({
            kind: 'admin-classes',
            classes: [createAdminClassSummary()],
            hasMore: false,
          });
        }
        if (command.kind === 'admin-class') {
          return Promise.resolve({ kind: 'admin-class', ...createAdminClassDetail() });
        }
        return Promise.resolve({ kind: 'ok' });
      });
    vi.stubGlobal('tro', { controlClassroom: send });
    render(page());
    fireEvent.click(await screen.findByRole('button', { name: 'Admin view' }));
    expect(await screen.findByText('Class A student current')).toBeTruthy();
    changed = true;
    const refreshClasses = intervals.mock.calls.find(([, delay]) => delay === 10_000)?.[0];
    expect(refreshClasses).toBeTypeOf('function');
    await act(async () => {
      if (typeof refreshClasses === 'function') {
        refreshClasses();
      }
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByText('Class A student current')).toBeNull();
    });
    expect(screen.queryByText('Read-only admin view')).toBeNull();
    if (outcome === 'revoked') {
      expect(screen.queryByRole('button', { name: 'Admin view' })).toBeNull();
    }
  },
);
