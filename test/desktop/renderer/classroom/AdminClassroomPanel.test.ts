// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClassroomFailure, type ClassroomReply } from '#contracts/Classroom.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { AdminClassroomPanel } from '../../../../src/desktop/renderer/classroom/AdminClassroomPanel.js';
import {
  createAdminClassDetail,
  createAdminClassSummary,
  firstClassId,
  firstSessionId,
  secondClassId,
  secondSessionId,
} from './AdminClassroomFixtures.js';

const translate = (english: string): string => english;
const onAccessLost = vi.fn<() => void>();

function panel(userId = 'admin'): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(AdminClassroomPanel, { userId, onAccessLost, t: translate }),
  });
}

function createDeferredReply(): {
  promise: Promise<ClassroomReply>;
  resolve: (reply: ClassroomReply) => void;
} {
  let resolveReply: (reply: ClassroomReply) => void = () => {};
  const promise = new Promise<ClassroomReply>((resolve) => {
    resolveReply = resolve;
  });
  return { promise, resolve: resolveReply };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('switches classes and ignores a late previous class response', async () => {
  const firstReply = createDeferredReply();
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) => {
      if (command.kind === 'admin-classes') {
        return Promise.resolve({
          kind: 'admin-classes',
          classes: [createAdminClassSummary(), createAdminClassSummary(secondClassId)],
          hasMore: false,
        });
      }
      if (command.kind === 'admin-class') {
        return command.classId === firstClassId
          ? firstReply.promise
          : Promise.resolve({ kind: 'admin-class', ...createAdminClassDetail(secondClassId) });
      }
      return Promise.resolve({ kind: 'failed', code: ClassroomFailure.INVALID });
    });
  vi.stubGlobal('tro', { controlClassroom: send });
  render(panel());
  fireEvent.click(await screen.findByRole('combobox', { name: 'Class to view' }));
  fireEvent.click(screen.getByRole('option', { name: /Class B/ }));
  expect(await screen.findByRole('heading', { name: 'Class B' })).toBeTruthy();
  await act(async () => {
    firstReply.resolve({ kind: 'admin-class', ...createAdminClassDetail() });
    await firstReply.promise;
  });
  expect(screen.queryByRole('heading', { name: 'Class A' })).toBeNull();
  expect(screen.getByText('Class B student current')).toBeTruthy();
  expect(screen.getByText('Read-only admin view')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: /Join class|Start session|Add student|End session/ }),
  ).toBeNull();
  expect(
    send.mock.calls.every(
      ([command]) => command.kind === 'admin-class' || command.kind === 'admin-classes',
    ),
  ).toBe(true);
});

it('clears class data on account changes and rejects old pending responses', async () => {
  const previousReply = createDeferredReply();
  const nextList = createDeferredReply();
  let nextAccount = false;
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) => {
      if (command.kind === 'admin-classes') {
        return nextAccount
          ? nextList.promise
          : Promise.resolve({
              kind: 'admin-classes',
              classes: [createAdminClassSummary()],
              hasMore: false,
            });
      }
      return previousReply.promise;
    });
  vi.stubGlobal('tro', { controlClassroom: send });
  const view = render(panel());
  await waitFor(() => {
    expect(send).toHaveBeenCalledWith({ kind: 'admin-class', classId: firstClassId });
  });
  nextAccount = true;
  view.rerender(panel('another-admin'));
  expect(screen.queryByRole('combobox', { name: 'Class to view' })).toBeNull();
  await act(async () => {
    previousReply.resolve({ kind: 'admin-class', ...createAdminClassDetail() });
    await previousReply.promise;
  });
  expect(screen.queryByText('Class A student current')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Class A' })).toBeNull();
});

it('loads only the selected historical session roster', async () => {
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) => {
      if (command.kind === 'admin-classes') {
        return Promise.resolve({
          kind: 'admin-classes',
          classes: [createAdminClassSummary()],
          hasMore: false,
        });
      }
      if (command.kind === 'admin-class') {
        return Promise.resolve({
          kind: 'admin-class',
          ...createAdminClassDetail(command.classId, command.classSessionId ?? firstSessionId),
        });
      }
      return Promise.resolve({ kind: 'failed', code: ClassroomFailure.INVALID });
    });
  vi.stubGlobal('tro', { controlClassroom: send });
  render(panel());
  fireEvent.click(await screen.findByRole('combobox', { name: 'Session to view' }));
  fireEvent.click(screen.getByRole('option', { name: 'Session 2 · Ended' }));
  expect(await screen.findByText('Class A student past')).toBeTruthy();
  expect(screen.queryByText('Class A student current')).toBeNull();
  expect(send).toHaveBeenLastCalledWith({
    kind: 'admin-class',
    classId: firstClassId,
    classSessionId: secondSessionId,
  });
});

it('searches across teachers and keeps pagination scoped to the current search', async () => {
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) => {
      if (command.kind === 'admin-classes') {
        return Promise.resolve({
          kind: 'admin-classes',
          classes: [createAdminClassSummary(command.offset === 0 ? firstClassId : secondClassId)],
          hasMore: command.offset === 0,
        });
      }
      if (command.kind === 'admin-class') {
        return Promise.resolve({ kind: 'admin-class', ...createAdminClassDetail(command.classId) });
      }
      return Promise.resolve({ kind: 'failed', code: ClassroomFailure.INVALID });
    });
  vi.stubGlobal('tro', { controlClassroom: send });
  render(panel());
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
  expect(await screen.findByRole('heading', { name: 'Class B' })).toBeTruthy();
  expect(send).toHaveBeenCalledWith({ kind: 'admin-classes', search: '', offset: 1 });
  fireEvent.change(screen.getByRole('textbox', { name: 'Find classes or teachers' }), {
    target: { value: ' teacher@example.test ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByRole('heading', { name: 'Class A' })).toBeTruthy();
  expect(send).toHaveBeenCalledWith({
    kind: 'admin-classes',
    search: 'teacher@example.test',
    offset: 0,
  });
  expect(screen.getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', true);
});

it('clears sensitive class data when a subsequent read denies admin access', async () => {
  let revoked = false;
  const send = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation((command) => {
      if (revoked) {
        return Promise.resolve({ kind: 'failed', code: ClassroomFailure.FORBIDDEN });
      }
      if (command.kind === 'admin-classes') {
        return Promise.resolve({
          kind: 'admin-classes',
          classes: [createAdminClassSummary()],
          hasMore: false,
        });
      }
      return Promise.resolve({ kind: 'admin-class', ...createAdminClassDetail() });
    });
  vi.stubGlobal('tro', { controlClassroom: send });
  render(panel());
  expect(await screen.findByText('Class A student current')).toBeTruthy();
  revoked = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh classes' }));
  await waitFor(() => {
    expect(onAccessLost).toHaveBeenCalledOnce();
  });
  expect(screen.queryByText('Class A student current')).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Class to view' })).toBeNull();
});
