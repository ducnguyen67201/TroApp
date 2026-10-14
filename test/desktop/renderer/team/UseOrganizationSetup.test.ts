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
import { useOrganizationSetup } from '../../../../src/desktop/renderer/team/UseOrganizationSetup.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const pendingHome: Extract<OrganizationReply, { kind: 'home' }> = {
  kind: 'home',
  organizations: [
    {
      id: organizationId,
      name: 'Organization',
      ownerUserId: 'owner',
      isOwner: true,
      isNameSet: false,
      role: AccountRole.STUDENT,
    },
  ],
  isAdmin: false,
};
const emptyHome: OrganizationReply = { kind: 'home', organizations: [], isAdmin: false };

function createBridge() {
  const controlOrganizations = vi
    .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
    .mockResolvedValue(pendingHome);
  Object.defineProperty(window, 'tro', { configurable: true, value: { controlOrganizations } });
  return controlOrganizations;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('requires a server check and offers recovery when the check fails', async () => {
  const control = createBridge().mockRejectedValueOnce(new Error('Offline'));
  const { result } = renderHook(() => useOrganizationSetup('owner'));
  expect(result.current.isBlocking).toBe(true);
  await waitFor(() => {
    expect(result.current.failure).toBe(OrganizationFailure.UNAVAILABLE);
  });
  expect(result.current.isBusy).toBe(false);
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.organization?.id).toBe(organizationId);
  expect(result.current.isBlocking).toBe(true);
  expect(result.current.failure).toBeNull();
  expect(control).toHaveBeenCalledTimes(2);
});

it('saves with the expected account and reconciles a lock from a competing login', async () => {
  const control = createBridge();
  const { result } = renderHook(() => useOrganizationSetup('owner'));
  await waitFor(() => {
    expect(result.current.organization).not.toBeNull();
  });
  control.mockResolvedValueOnce({ kind: 'failed', code: OrganizationFailure.CONFLICT });
  control.mockResolvedValueOnce({
    ...pendingHome,
    organizations: pendingHome.organizations.map((entry) => ({
      ...entry,
      name: 'Saved elsewhere',
      isNameSet: true,
    })),
  });
  await act(async () => {
    await result.current.saveName('Our school');
  });
  expect(control).toHaveBeenCalledWith({
    expectedAccountId: 'owner',
    command: { kind: OrganizationAction.SET_NAME, organizationId, name: 'Our school' },
  });
  expect(result.current.isBlocking).toBe(false);
  expect(result.current.organization).toBeNull();
});

it('keeps unfinished setup after a failed save and retries without losing the account scope', async () => {
  const control = createBridge();
  const { result } = renderHook(() => useOrganizationSetup('owner'));
  await waitFor(() => {
    expect(result.current.organization).not.toBeNull();
  });
  control.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => {
    await result.current.saveName('Our school');
  });
  expect(result.current.failure).toBe(OrganizationFailure.UNAVAILABLE);
  expect(result.current.isBlocking).toBe(true);
  control.mockResolvedValueOnce({ kind: 'ok' });
  control.mockResolvedValueOnce({
    ...pendingHome,
    organizations: pendingHome.organizations.map((entry) => ({
      ...entry,
      name: 'Our school',
      isNameSet: true,
    })),
  });
  await act(async () => {
    await result.current.saveName('Our school');
  });
  expect(result.current.isBlocking).toBe(false);
});

it('fences a late save when switching accounts', async () => {
  const control = createBridge();
  const { result, rerender } = renderHook(({ accountId }) => useOrganizationSetup(accountId), {
    initialProps: { accountId: 'owner' },
  });
  await waitFor(() => {
    expect(result.current.organization).not.toBeNull();
  });
  let completeSave: ((reply: OrganizationReply) => void) | undefined;
  control.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeSave = resolve;
      }),
  );
  let saving: Promise<boolean> | undefined;
  act(() => {
    saving = result.current.saveName('Private school');
  });
  control.mockResolvedValueOnce(emptyHome);
  rerender({ accountId: 'other' });
  expect(result.current.organization).toBeNull();
  await waitFor(() => {
    expect(result.current.isBlocking).toBe(false);
  });
  await act(async () => {
    completeSave?.({ kind: 'ok' });
    await saving;
  });
  expect(result.current.organization).toBeNull();
  expect(control).toHaveBeenLastCalledWith({
    expectedAccountId: 'other',
    command: { kind: OrganizationAction.HOME },
  });
});

it('does not prompt members or owners of already-named organizations', async () => {
  const control = createBridge().mockResolvedValue({
    ...pendingHome,
    organizations: pendingHome.organizations.map((entry) => ({ ...entry, isOwner: false })),
  });
  const { result } = renderHook(() => useOrganizationSetup('member'));
  await waitFor(() => {
    expect(result.current.isBusy).toBe(false);
  });
  expect(result.current.isBlocking).toBe(false);
  control.mockResolvedValue({
    ...pendingHome,
    organizations: [
      {
        id: organizationId,
        name: 'Existing school',
        ownerUserId: 'member',
        isOwner: true,
        role: AccountRole.STUDENT,
      },
    ],
  });
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.isBlocking).toBe(false);
});

it('fences a late first-login read after sign-out', async () => {
  const control = createBridge();
  let completeRead: ((reply: OrganizationReply) => void) | undefined;
  control.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeRead = resolve;
      }),
  );
  const initialProps: { accountId: string | null } = { accountId: 'owner' };
  const { result, rerender } = renderHook(
    ({ accountId }: { accountId: string | null }) => useOrganizationSetup(accountId),
    { initialProps },
  );
  rerender({ accountId: null });
  await act(async () => {
    completeRead?.(pendingHome);
    await Promise.resolve();
  });
  expect(result.current.organization).toBeNull();
  expect(result.current.isBlocking).toBe(false);
  expect(control).toHaveBeenCalledTimes(1);
});

it('preserves a completed check when a later team refresh loses its connection', async () => {
  const control = createBridge().mockResolvedValue(emptyHome);
  const { result } = renderHook(() => useOrganizationSetup('member'));
  await waitFor(() => {
    expect(result.current.isBlocking).toBe(false);
  });
  control.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.failure).toBe(OrganizationFailure.UNAVAILABLE);
  expect(result.current.isBlocking).toBe(false);
});

it('refreshes organization artwork and membership when the desktop regains focus', async () => {
  const control = createBridge().mockResolvedValue({
    ...pendingHome,
    organizations: pendingHome.organizations.map((entry) => ({
      ...entry,
      isNameSet: true,
      logoDataUrl: null,
    })),
  });
  const { result } = renderHook(() => useOrganizationSetup('owner'));
  await waitFor(() => {
    expect(result.current.organizations).toHaveLength(1);
  });
  control.mockResolvedValue(emptyHome);
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await waitFor(() => {
    expect(result.current.organizations).toEqual([]);
  });
});

it('persists the personal-use choice and lets an approved owner reopen creation later', async () => {
  const firstHome: OrganizationReply = {
    kind: 'home',
    organizations: [],
    isAdmin: false,
    canCreateOrganization: true,
    hasChosenOrganization: false,
  };
  const control = createBridge().mockResolvedValue(firstHome);
  const { result } = renderHook(() => useOrganizationSetup('owner'));
  await waitFor(() => {
    expect(result.current.canCreateOrganization).toBe(true);
  });
  expect(result.current.isBlocking).toBe(true);
  control
    .mockResolvedValueOnce({ kind: 'ok' })
    .mockResolvedValueOnce({ ...firstHome, hasChosenOrganization: true });
  await act(async () => {
    await result.current.continuePersonal();
  });
  expect(control).toHaveBeenCalledWith({
    expectedAccountId: 'owner',
    command: { kind: OrganizationAction.CONTINUE_PERSONAL },
  });
  expect(result.current.isBlocking).toBe(false);
  act(() => {
    result.current.openChoice();
  });
  expect(result.current.isBlocking).toBe(true);
  control.mockResolvedValueOnce({ kind: 'ok' }).mockResolvedValueOnce({
    ...pendingHome,
    hasChosenOrganization: true,
    organizations: pendingHome.organizations.map((entry) => ({
      ...entry,
      name: 'Created school',
      isNameSet: true,
    })),
  });
  await act(async () => {
    await result.current.saveName('Created school');
  });
  expect(control).toHaveBeenCalledWith({
    expectedAccountId: 'owner',
    command: { kind: OrganizationAction.CREATE_OWN_ORGANIZATION, name: 'Created school' },
  });
  expect(result.current.isBlocking).toBe(false);
});

it('allows deferred setup of an old admin-provisioned organization', async () => {
  const control = createBridge();
  const { result } = renderHook(() => useOrganizationSetup('owner'));
  await waitFor(() => {
    expect(result.current.organization).not.toBeNull();
  });
  control
    .mockResolvedValueOnce({ kind: 'ok' })
    .mockResolvedValueOnce({ ...pendingHome, hasChosenOrganization: true });
  await act(async () => {
    await result.current.continuePersonal();
  });
  expect(result.current.isBlocking).toBe(false);
});
