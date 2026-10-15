// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { StudentAccessKind, type StudentAccessReply } from '#contracts/StudentAccess.js';
import { OrganizationComputerPanel } from '../../../../src/desktop/renderer/team/OrganizationComputerPanel.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const admissionId = '33333333-3333-4333-8333-333333333333';
beforeEach(() => {
  localStorage.setItem('tro.desktop.locale', 'en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('shows separate student and login counts and creates/revokes organization computer access', async () => {
  const usage: StudentAccessReply = {
    kind: StudentAccessKind.ORGANIZATION_ACCESS,
    organizationId,
    day: '2026-10-14',
    authorizedComputers: 1,
    registeredStudents: 2,
    studentsToday: 1,
    signInsToday: 20,
    totalSignIns: 30,
    computers: [
      {
        id: deviceId,
        name: 'Computer 1',
        createdAt: '2026-10-14T00:00:00.000Z',
        lastSignInAt: '2026-10-14T10:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        revoked: false,
      },
    ],
    activationCodes: [{ id: admissionId, activations: 1, expiresAt: '2030-01-01T00:00:00.000Z' }],
  };
  const control = vi
    .fn<NonNullable<DesktopBridge['controlStudentAccess']>>()
    .mockImplementation((command) =>
      Promise.resolve(
        command.kind === StudentAccessKind.ORGANIZATION_ACCESS
          ? usage
          : command.kind === StudentAccessKind.CREATE_COMPUTER_CODE
            ? {
                kind: 'admission',
                code: 'TRO-ABCDEFGHIJKLMNOP',
                mode: 'shared',
                expiresAt: '2030-01-01T00:00:00.000Z',
              }
            : { kind: 'done' },
      ),
    );
  Object.defineProperty(window, 'tro', {
    configurable: true,
    value: { controlStudentAccess: control },
  });
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(OrganizationComputerPanel, { organizationId }),
      }),
    }),
  );
  expect(await screen.findByText('Unique student accounts: 2')).toBeTruthy();
  expect(screen.getByText('Students signed in today (UTC): 1')).toBeTruthy();
  expect(screen.getByText('Sign-ins today / all time: 20 / 30')).toBeTruthy();
  expect(screen.queryByLabelText(/Computer name/)).toBeNull();
  expect(screen.getByText('Computer 1')).toBeTruthy();
  expect(screen.getByText(/Computers activated: 1/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create organization activation code' }));
  expect(await screen.findByDisplayValue('TRO-ABCDEFGHIJKLMNOP')).toBeTruthy();
  expect(screen.getByText(/Reusable across this organization/)).toBeTruthy();
  expect(screen.getByText(/Computers already authorized stay active/)).toBeTruthy();
  expect(control).toHaveBeenCalledWith({
    kind: StudentAccessKind.CREATE_COMPUTER_CODE,
    organizationId,
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Stop new activations' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  fireEvent.click(screen.getByRole('button', { name: 'Stop new activations' }));
  await waitFor(() => {
    expect(control).toHaveBeenCalledWith({
      kind: StudentAccessKind.REVOKE_COMPUTER_CODE,
      organizationId,
      admissionId,
    });
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Revoke computer' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  fireEvent.click(screen.getByRole('button', { name: 'Revoke computer' }));
  await waitFor(() => {
    expect(control).toHaveBeenCalledWith({
      kind: StudentAccessKind.REVOKE_COMPUTER,
      organizationId,
      deviceId,
    });
  });
});
