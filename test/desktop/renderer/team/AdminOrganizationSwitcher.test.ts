// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrganizationAction } from '#contracts/Organizations.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { useOrganizationSetup } from '../../../../src/desktop/renderer/team/UseOrganizationSetup.js';
import { AdminOrganizationSwitcher } from '../../../../src/desktop/renderer/team/AdminOrganizationSwitcher.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';

const school = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Codespace Education',
  ownerUserId: 'owner',
  isOwner: false,
  role: null,
  isNameSet: true,
};

function Workspace({ accountId }: { accountId: string }): ReactElement {
  const view = useOrganizationSetup(accountId);
  return view.isAdmin
    ? createElement(AdminOrganizationSwitcher, {
        view,
        disabled: false,
        onSelect: async (organizationId) => {
          await view.selectAdminOrganization(organizationId);
        },
      })
    : createElement('span', {}, 'Personal account');
}

function page(accountId = 'admin'): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(LocaleProvider, { children: createElement(Workspace, { accountId }) }),
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

it('switches an admin into a directory-only organization and clears the selector on account change', async () => {
  window.localStorage.setItem('tro.desktop.locale', 'en');
  let scope: string | null = null;
  const control = vi
    .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
    .mockImplementation(({ command, expectedAccountId }) => {
      if (command.kind === OrganizationAction.SELECT_ADMIN_ORGANIZATION) {
        scope = command.organizationId;
        return Promise.resolve({
          kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION,
          organization: scope ? school : null,
        });
      }
      return Promise.resolve({
        kind: 'home',
        organizations: expectedAccountId === 'admin' ? [school] : [],
        isAdmin: expectedAccountId === 'admin',
        hasChosenOrganization: true,
        adminOrganizationId: scope,
      });
    });
  vi.stubGlobal('tro', { controlOrganizations: control });
  const view = render(page());
  const picker = await screen.findByRole('combobox', { name: 'Admin organization' });
  fireEvent.change(picker, { target: { value: school.id } });
  await waitFor(() => {
    expect(picker.getAttribute('disabled')).toBeNull();
    expect(scope).toBe(school.id);
  });
  expect(await screen.findByText(/Viewing and editing this organization/)).toBeTruthy();
  expect(control).toHaveBeenCalledWith({
    expectedAccountId: 'admin',
    command: { kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION, organizationId: school.id },
  });
  view.rerender(page('member'));
  await screen.findByText('Personal account');
  expect(screen.queryByRole('combobox', { name: 'Admin organization' })).toBeNull();
});

it('retains the prior organization after a refused switch', async () => {
  window.localStorage.setItem('tro.desktop.locale', 'en');
  const control = vi
    .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
    .mockImplementation(({ command }) =>
      Promise.resolve(
        command.kind === OrganizationAction.SELECT_ADMIN_ORGANIZATION
          ? { kind: 'failed', code: 'unavailable' }
          : {
              kind: 'home',
              organizations: [school],
              isAdmin: true,
              hasChosenOrganization: true,
              adminOrganizationId: school.id,
            },
      ),
    );
  vi.stubGlobal('tro', { controlOrganizations: control });
  render(page());
  const picker = await screen.findByRole('combobox', { name: 'Admin organization' });
  fireEvent.change(picker, { target: { value: '' } });
  await screen.findByRole('alert');
  expect(picker).toHaveProperty('value', school.id);
});
