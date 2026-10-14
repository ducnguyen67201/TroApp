// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationFailure,
  type OrganizationReply,
} from '#contracts/Organizations.js';
import { useTeam } from '../../../../src/desktop/renderer/team/UseTeam.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const home: OrganizationReply = {
  kind: 'home',
  organizations: [
    {
      id: organizationId,
      name: 'Our school',
      ownerUserId: 'owner',
      role: AccountRole.STUDENT,
      isOwner: false,
    },
  ],
  isAdmin: false,
};

function createBridge() {
  return {
    controlOrganizations: vi
      .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
      .mockResolvedValue(home),
  } satisfies Pick<DesktopBridge, 'controlOrganizations'>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('never requests a private roster for a regular member', async () => {
  const bridge = createBridge();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const { result } = renderHook(() => useTeam('student'));
  await waitFor(() => {
    expect(result.current.home).not.toBeNull();
  });
  expect(result.current.team).toBeNull();
  expect(bridge.controlOrganizations).toHaveBeenCalledExactlyOnceWith({
    expectedAccountId: 'student',
    command: { kind: OrganizationAction.HOME },
  });
});

it('fences late private roster reads when the active account changes', async () => {
  const bridge = createBridge();
  let finishRead: ((reply: OrganizationReply) => void) | undefined;
  bridge.controlOrganizations
    .mockResolvedValueOnce({
      kind: 'home',
      organizations: [
        {
          id: organizationId,
          name: 'First school',
          ownerUserId: 'first',
          role: AccountRole.TEACHER,
          isOwner: true,
        },
      ],
      isAdmin: false,
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const { result, rerender } = renderHook(({ accountId }) => useTeam(accountId), {
    initialProps: { accountId: 'first' },
  });
  await waitFor(() => {
    expect(bridge.controlOrganizations).toHaveBeenCalledTimes(2);
  });
  rerender({ accountId: 'second' });
  await waitFor(() => {
    expect(result.current.home).toEqual(home);
  });
  await act(async () => {
    finishRead?.({
      kind: 'team',
      organization: { id: organizationId, name: 'Private school', ownerUserId: 'first' },
      members: [],
      invitations: [],
    });
    await Promise.resolve();
  });
  expect(result.current.team).toBeNull();
  expect(result.current.home).toEqual(home);
  expect(bridge.controlOrganizations).toHaveBeenLastCalledWith({
    expectedAccountId: 'second',
    command: { kind: OrganizationAction.HOME },
  });
});

it('notifies the classroom after a direct add succeeds even if its refresh fails', async () => {
  const bridge = createBridge();
  const onChanged = vi.fn<() => void>();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const { result } = renderHook(() => useTeam('student', onChanged));
  await waitFor(() => {
    expect(result.current.home).not.toBeNull();
  });
  bridge.controlOrganizations
    .mockResolvedValueOnce({ kind: 'ok' })
    .mockResolvedValueOnce({ kind: 'failed', code: OrganizationFailure.UNAVAILABLE });
  await act(async () => {
    await result.current.sendCommand({
      kind: OrganizationAction.ADD_MEMBER,
      organizationId,
      email: 'person@example.test',
      role: AccountRole.STUDENT,
    });
  });
  expect(onChanged).toHaveBeenCalledOnce();
  expect(result.current.failure).toBe(OrganizationFailure.UNAVAILABLE);
  bridge.controlOrganizations.mockResolvedValueOnce({
    kind: 'failed',
    code: OrganizationFailure.CONFLICT,
  });
  await act(async () => {
    await result.current.sendCommand({
      kind: OrganizationAction.CONTINUE_PERSONAL,
    });
  });
  expect(onChanged).toHaveBeenCalledOnce();
  expect(result.current.failure).toBe(OrganizationFailure.CONFLICT);
});

it('ignores a previous account’s late mutation and prevents overlapping writes', async () => {
  const bridge = createBridge();
  const onChanged = vi.fn<() => void>();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const { result, rerender } = renderHook(({ accountId }) => useTeam(accountId, onChanged), {
    initialProps: { accountId: 'first' },
  });
  await waitFor(() => {
    expect(result.current.home).not.toBeNull();
  });
  let finishSave: ((reply: OrganizationReply) => void) | undefined;
  bridge.controlOrganizations.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  let saved: Promise<boolean> | undefined;
  act(() => {
    saved = result.current.sendCommand({
      kind: OrganizationAction.CONTINUE_PERSONAL,
    });
  });
  await act(async () => {
    expect(
      await result.current.sendCommand({
        kind: OrganizationAction.CONTINUE_PERSONAL,
      }),
    ).toBe(false);
  });
  expect(bridge.controlOrganizations).toHaveBeenCalledTimes(2);
  rerender({ accountId: 'second' });
  await waitFor(() => {
    expect(result.current.home).not.toBeNull();
  });
  await act(async () => {
    finishSave?.({ kind: 'ok' });
    expect(await saved).toBe(false);
  });
  expect(onChanged).not.toHaveBeenCalled();
  expect(result.current.home).toEqual(home);
  expect(bridge.controlOrganizations).toHaveBeenCalledTimes(3);
});

it('rejects an unexpected invitation reply without notifying classroom consumers', async () => {
  const bridge = createBridge();
  const onChanged = vi.fn<() => void>();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const { result } = renderHook(() => useTeam('student', onChanged));
  await waitFor(() => {
    expect(result.current.home).not.toBeNull();
  });
  bridge.controlOrganizations.mockResolvedValueOnce({
    kind: 'invitation',
    code: 'a'.repeat(43),
    expiresAt: '2026-10-21T12:00:00.000Z',
  });
  await act(async () => {
    expect(
      await result.current.sendCommand({
        kind: OrganizationAction.ADD_MEMBER,
        organizationId,
        email: 'person@example.test',
        role: AccountRole.STUDENT,
      }),
    ).toBe(false);
  });
  expect(result.current.failure).toBe(OrganizationFailure.UNAVAILABLE);
  expect(onChanged).not.toHaveBeenCalled();
});
