// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { StudentAccessKind } from '#contracts/StudentAccess.js';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationFailure,
  type OrganizationReply,
} from '#contracts/Organizations.js';
import { TeamPanel } from '../../../../src/desktop/renderer/team/TeamPanel.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const organization = { id: organizationId, name: 'Our school', ownerUserId: 'owner' };
const team: Extract<OrganizationReply, { kind: 'team' }> = {
  kind: 'team',
  organization,
  members: [
    {
      userId: 'owner',
      name: 'School owner',
      email: 'owner@example.test',
      role: AccountRole.TEACHER,
      joinedAt: '2026-10-01T12:00:00.000Z',
    },
    {
      userId: 'student',
      name: 'Learner',
      email: 'student@example.test',
      role: AccountRole.STUDENT,
      joinedAt: '2026-10-02T12:00:00.000Z',
    },
  ],
  invitations: [],
  emailMembers: [
    { email: 'added@example.test', role: AccountRole.STUDENT, addedAt: '2026-10-14T12:00:00.000Z' },
  ],
};

function createBridge(isOwner = false, isAdmin = false, adminOrganizationId?: string) {
  const home: OrganizationReply = {
    kind: 'home',
    organizations: [
      { ...organization, role: isOwner ? AccountRole.TEACHER : AccountRole.STUDENT, isOwner },
    ],
    isAdmin,
    ...(adminOrganizationId ? { adminOrganizationId } : {}),
  };
  return {
    controlOrganizations: vi
      .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
      .mockImplementation(({ command }): Promise<OrganizationReply> => {
        if (command.kind === OrganizationAction.HOME) {
          return Promise.resolve(home);
        }
        if (command.kind === OrganizationAction.TEAM) {
          return Promise.resolve(team);
        }
        return Promise.resolve({ kind: 'ok' });
      }),
  } satisfies Pick<DesktopBridge, 'controlOrganizations'>;
}

function renderTeam(onChanged?: () => void) {
  return render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(TeamPanel, { accountId: 'current', onChanged }),
      }),
    }),
  );
}

async function waitForTeamReady(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Refresh team' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
}

it.each([
  { isOwner: false, isAdmin: false, scope: undefined, visible: false },
  { isOwner: true, isAdmin: false, scope: undefined, visible: true },
  { isOwner: false, isAdmin: true, scope: undefined, visible: false },
  { isOwner: true, isAdmin: true, scope: undefined, visible: false },
  { isOwner: false, isAdmin: true, scope: '22222222-2222-4222-8222-222222222222', visible: false },
  { isOwner: true, isAdmin: true, scope: '22222222-2222-4222-8222-222222222222', visible: false },
  { isOwner: false, isAdmin: true, scope: organizationId, visible: true },
  { isOwner: true, isAdmin: true, scope: organizationId, visible: true },
])(
  'computer controls respect owner/admin scope: $isOwner/$isAdmin/$scope',
  async ({ isOwner, isAdmin, scope, visible }) => {
    const controlStudentAccess = vi
      .fn<NonNullable<DesktopBridge['controlStudentAccess']>>()
      .mockResolvedValue({
        kind: StudentAccessKind.ORGANIZATION_ACCESS,
        organizationId,
        day: '2026-10-14',
        authorizedComputers: 0,
        registeredStudents: 0,
        studentsToday: 0,
        signInsToday: 0,
        totalSignIns: 0,
        computers: [],
        activationCodes: [],
      });
    Object.defineProperty(window, 'tro', {
      configurable: true,
      value: { ...createBridge(isOwner, isAdmin, scope), controlStudentAccess },
    });
    renderTeam();
    await screen.findByText(isOwner ? 'Your role: Teacher' : 'Your role: Student');
    if (visible) {
      expect(
        await screen.findByRole('button', { name: 'Create organization activation code' }),
      ).toBeTruthy();
      await waitFor(() => {
        expect(controlStudentAccess).toHaveBeenCalledWith({
          kind: StudentAccessKind.ORGANIZATION_ACCESS,
          organizationId,
        });
      });
    } else {
      expect(
        screen.queryByRole('button', { name: 'Create organization activation code' }),
      ).toBeNull();
      expect(controlStudentAccess).not.toHaveBeenCalled();
    }
  },
);

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('shows regular members their organization and role without a roster, email directory or owner/admin controls', async () => {
  const bridge = createBridge();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderTeam();
  await screen.findByText('Your role: Student');
  expect(screen.queryByRole('region', { name: 'Members' })).toBeNull();
  expect(screen.queryByText('student@example.test')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create invitation' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Organization logo' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Grant ownership' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create organization' })).toBeNull();
  expect(bridge.controlOrganizations).toHaveBeenCalledExactlyOnceWith({
    expectedAccountId: 'current',
    command: { kind: OrganizationAction.HOME },
  });
});

it('lets an owner change teacher/student roles and confirms removal while protecting the owner', async () => {
  const bridge = createBridge(true);
  const onChanged = vi.fn<() => void>();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderTeam(onChanged);
  const owner = await screen.findByRole('region', { name: 'School owner' });
  await waitForTeamReady();
  expect(within(owner).queryByRole('button', { name: 'Remove member' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Grant ownership' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Organization name' })).toBeNull();
  const role = screen.getByLabelText('Role: Learner');
  expect(within(role).queryByRole('option', { name: 'Owner' })).toBeNull();
  fireEvent.change(role, { target: { value: AccountRole.TEACHER } });
  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledOnce();
  });
  expect(bridge.controlOrganizations).toHaveBeenCalledWith({
    expectedAccountId: 'current',
    command: {
      kind: OrganizationAction.CHANGE_ROLE,
      organizationId,
      userId: 'student',
      role: AccountRole.TEACHER,
    },
  });
  const learner = await screen.findByRole('region', { name: 'Learner' });
  await waitForTeamReady();
  fireEvent.click(within(learner).getByRole('button', { name: 'Remove member' }));
  expect(
    bridge.controlOrganizations.mock.calls.some(
      ([request]) => request.command.kind === OrganizationAction.REMOVE_MEMBER,
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
  expect(bridge.controlOrganizations).toHaveBeenCalledWith({
    expectedAccountId: 'current',
    command: { kind: OrganizationAction.REMOVE_MEMBER, organizationId, userId: 'student' },
  });
});

it('adds a member directly with the selected permissions and no invitation step', async () => {
  const bridge = createBridge(true);
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderTeam();
  await screen.findByRole('region', { name: 'Members' });
  await waitForTeamReady();
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
  const form = screen.getByRole('form', { name: 'Add member' });
  fireEvent.change(within(form).getByRole('textbox', { name: 'Email' }), {
    target: { value: 'new@example.test' },
  });
  fireEvent.change(within(form).getByLabelText('Permissions'), {
    target: { value: AccountRole.TEACHER },
  });
  fireEvent.click(within(form).getByRole('button', { name: 'Add member' }));
  await waitFor(() => {
    expect(screen.queryByRole('form', { name: 'Add member' })).toBeNull();
  });
  expect(bridge.controlOrganizations).toHaveBeenCalledWith({
    expectedAccountId: 'current',
    command: {
      kind: OrganizationAction.ADD_MEMBER,
      organizationId,
      email: 'new@example.test',
      role: AccountRole.TEACHER,
    },
  });
  expect(screen.queryByRole('textbox', { name: 'Invitation code' })).toBeNull();
  expect(screen.queryByText('Pending invitations')).toBeNull();
});

it('offers admin ownership controls without exposing owner-only membership controls', async () => {
  const bridge = createBridge(false, true);
  const onChanged = vi.fn<() => void>();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderTeam(onChanged);
  fireEvent.click(await screen.findByRole('button', { name: 'Owner approvals' }));
  const ownership = await screen.findByRole('region', { name: 'Organization ownership' });
  await waitForTeamReady();
  expect(screen.queryByRole('region', { name: 'Members' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create invitation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create organization' })).toBeNull();
  fireEvent.change(within(ownership).getByRole('textbox', { name: 'New owner’s verified email' }), {
    target: { value: 'replacement@example.test' },
  });
  fireEvent.click(within(ownership).getByRole('button', { name: 'Grant ownership' }));
  expect(onChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm ownership change' }));
  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledOnce();
  });
  expect(bridge.controlOrganizations).toHaveBeenCalledWith({
    expectedAccountId: 'current',
    command: {
      kind: OrganizationAction.GRANT_OWNER,
      organizationId,
      email: 'replacement@example.test',
    },
  });
});

it('keeps the add-member draft after a failed write and refreshes only after success', async () => {
  const bridge = createBridge(true);
  const onChanged = vi.fn<() => void>();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderTeam(onChanged);
  await screen.findByRole('region', { name: 'Members' });
  await waitForTeamReady();
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
    target: { value: 'new@example.test' },
  });
  bridge.controlOrganizations.mockResolvedValueOnce({
    kind: 'failed',
    code: OrganizationFailure.CONFLICT,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
  await screen.findByRole('alert');
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Email' })).toHaveProperty(
    'value',
    'new@example.test',
  );
  await waitForTeamReady();
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
  await waitFor(() => {
    expect(onChanged).toHaveBeenCalledOnce();
  });
});

it('approves owners without creating organizations inside Team settings', async () => {
  const bridge = createBridge(false, true);
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderTeam();
  fireEvent.click(await screen.findByRole('button', { name: 'Owner approvals' }));
  const approval = await screen.findByRole('region', { name: 'Approve an organization owner' });
  await waitForTeamReady();
  fireEvent.change(within(approval).getByRole('textbox', { name: 'Owner’s verified email' }), {
    target: { value: 'owner@example.test' },
  });
  fireEvent.click(within(approval).getByRole('button', { name: 'Approve owner' }));
  await waitFor(() => {
    expect(bridge.controlOrganizations).toHaveBeenCalledWith({
      expectedAccountId: 'current',
      command: { kind: OrganizationAction.APPROVE_OWNER, email: 'owner@example.test' },
    });
  });
  expect(screen.queryByRole('region', { name: 'Create an organization' })).toBeNull();
});

it('changes permissions and removes owner-added emails before their first sign-in', async () => {
  const bridge = createBridge(true);
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderTeam();
  await screen.findByText('Added · joins automatically on sign-in');
  await waitForTeamReady();
  fireEvent.change(screen.getByLabelText('Role: added@example.test'), {
    target: { value: AccountRole.TEACHER },
  });
  await waitForTeamReady();
  expect(bridge.controlOrganizations).toHaveBeenCalledWith({
    expectedAccountId: 'current',
    command: {
      kind: OrganizationAction.CHANGE_EMAIL_ROLE,
      organizationId,
      email: 'added@example.test',
      role: AccountRole.TEACHER,
    },
  });
  const member = await screen.findByRole('region', { name: 'added@example.test' });
  fireEvent.click(within(member).getByRole('button', { name: 'Remove member' }));
  fireEvent.click(within(member).getByRole('button', { name: 'Confirm removal' }));
  await waitFor(() => {
    expect(bridge.controlOrganizations).toHaveBeenCalledWith({
      expectedAccountId: 'current',
      command: {
        kind: OrganizationAction.REMOVE_EMAIL_MEMBER,
        organizationId,
        email: 'added@example.test',
      },
    });
  });
});

it('lets an owner add a class teacher without removing the existing one and confirm a personal class move', async () => {
  const bridge = createBridge(true);
  const classId = '22222222-2222-4222-8222-222222222222';
  const personalId = '33333333-3333-4333-8333-333333333333';
  bridge.controlOrganizations.mockImplementation(({ command }): Promise<OrganizationReply> => {
    if (command.kind === OrganizationAction.HOME) {
      return Promise.resolve({
        kind: 'home',
        organizations: [{ ...organization, role: AccountRole.TEACHER, isOwner: true }],
        isAdmin: false,
      });
    }
    if (command.kind === OrganizationAction.TEAM) {
      return Promise.resolve({
        ...team,
        members: [
          ...team.members,
          {
            userId: 'daniel',
            name: 'Daniel',
            email: 'daniel@example.test',
            role: AccountRole.TEACHER,
            joinedAt: '2026-10-14T12:00:00.000Z',
          },
        ],
        classes: [{ id: classId, name: 'Programming', teacherId: 'owner', hasLiveSession: false }],
        personalClasses: [
          { id: personalId, name: 'Personal class', teacherId: 'owner', hasLiveSession: false },
        ],
      });
    }
    return Promise.resolve({ kind: 'ok' });
  });
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderTeam();
  fireEvent.click(await screen.findByRole('button', { name: 'Class assignments' }));
  const classroom = await screen.findByRole('region', { name: 'Programming' });
  fireEvent.click(within(classroom).getByRole('checkbox', { name: 'Daniel' }));
  fireEvent.click(within(classroom).getByRole('button', { name: 'Save teachers' }));
  await waitFor(() => {
    expect(bridge.controlOrganizations).toHaveBeenCalledWith({
      expectedAccountId: 'current',
      command: {
        kind: OrganizationAction.SET_CLASS_TEACHERS,
        organizationId,
        classId,
        teacherIds: ['owner', 'daniel'],
        expectedTeacherIds: ['owner'],
      },
    });
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Class assignments' }));
  fireEvent.change(await screen.findByLabelText('Your personal class'), {
    target: { value: personalId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Link existing class' }));
  expect(
    bridge.controlOrganizations.mock.calls.some(
      ([request]) => request.command.kind === OrganizationAction.LINK_CLASS,
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm class move' }));
  await waitFor(() => {
    expect(bridge.controlOrganizations).toHaveBeenCalledWith({
      expectedAccountId: 'current',
      command: { kind: OrganizationAction.LINK_CLASS, organizationId, classId: personalId },
    });
  });
});
