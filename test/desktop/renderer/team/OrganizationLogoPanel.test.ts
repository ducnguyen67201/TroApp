// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrganizationAction } from '#contracts/Organizations.js';
import { OrganizationLogoPanel } from '../../../../src/desktop/renderer/team/OrganizationLogoPanel.js';
import { prepareOrganizationLogo } from '../../../../src/desktop/renderer/team/PrepareOrganizationLogo.js';
import type { TeamView } from '../../../../src/desktop/renderer/team/UseTeam.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  localeStorageKey,
  DesktopLocale,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import { organizationLogo } from '../../../server/features/organizations/OrganizationLogoFixtures.js';

vi.mock('../../../../src/desktop/renderer/team/PrepareOrganizationLogo.js', () => ({
  prepareOrganizationLogo: vi.fn<(file: File) => Promise<string>>(),
}));
const organization = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Our school',
  ownerUserId: 'owner',
  logoDataUrl: organizationLogo,
};

function renderLogo() {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
  const sendCommand = vi.fn<TeamView['sendCommand']>().mockResolvedValue(true);
  const view: TeamView = {
    home: null,
    team: null,
    selectedOrganizationId: organization.id,
    isAvailable: true,
    isLoading: false,
    isSaving: false,
    failure: null,
    refresh: vi.fn<TeamView['refresh']>(),
    selectOrganization: vi.fn<TeamView['selectOrganization']>(),
    sendCommand,
  };
  const rendered = render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(OrganizationLogoPanel, { organization, view }),
      }),
    }),
  );
  const input = rendered.container.querySelector('input[type="file"]');
  if (!input) {
    throw new Error('Missing logo file input');
  }
  return { ...rendered, input, sendCommand };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
});

it('prepares selected files before sending only logo bytes and supports removal', async () => {
  vi.mocked(prepareOrganizationLogo).mockResolvedValue(organizationLogo);
  const { input, sendCommand } = renderLogo();
  fireEvent.change(input, {
    target: { files: [new File(['local bytes'], 'private-name.png', { type: 'image/png' })] },
  });
  await waitFor(() => {
    expect(sendCommand).toHaveBeenCalledWith({
      kind: OrganizationAction.SET_LOGO,
      organizationId: organization.id,
      logoDataUrl: organizationLogo,
    });
  });
  expect(JSON.stringify(sendCommand.mock.calls)).not.toContain('private-name');
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Remove logo' })).toHaveProperty('disabled', false);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Remove logo' }));
  expect(sendCommand).toHaveBeenLastCalledWith({
    kind: OrganizationAction.SET_LOGO,
    organizationId: organization.id,
    logoDataUrl: null,
  });
});

it('does not send invalid images or files finishing after the owner panel closes', async () => {
  vi.mocked(prepareOrganizationLogo).mockRejectedValueOnce(new Error('Invalid image'));
  const { input, sendCommand, unmount } = renderLogo();
  const file = new File(['invalid'], 'invalid.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByRole('alert');
  expect(sendCommand).not.toHaveBeenCalled();
  let finish: ((logo: string) => void) | undefined;
  vi.mocked(prepareOrganizationLogo).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.change(input, {
    target: { files: [new File(['later'], 'later.png', { type: 'image/png' })] },
  });
  unmount();
  await act(async () => {
    finish?.(organizationLogo);
    await Promise.resolve();
  });
  expect(sendCommand).not.toHaveBeenCalled();
});
