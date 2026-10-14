// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import type { OrganizationSummary } from '#contracts/Organizations.js';
import { OrganizationBrand } from '../../../../src/desktop/renderer/team/OrganizationBrand.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  localeStorageKey,
  DesktopLocale,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import { organizationLogo } from '../../../server/features/organizations/OrganizationLogoFixtures.js';

const school: OrganizationSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Our school',
  logoDataUrl: organizationLogo,
  ownerUserId: 'owner',
  isOwner: false,
  role: AccountRole.STUDENT,
  isNameSet: true,
};

function renderBrand(accountId: string, organizations: OrganizationSummary[]) {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
  const createBrand = (nextAccountId: string, nextOrganizations: OrganizationSummary[]) =>
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(OrganizationBrand, {
          accountId: nextAccountId,
          organizations: nextOrganizations,
        }),
      }),
    });
  const rendered = render(createBrand(accountId, organizations));
  return {
    ...rendered,
    update: (nextAccountId: string, nextOrganizations: OrganizationSummary[]) => {
      rendered.rerender(createBrand(nextAccountId, nextOrganizations));
    },
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it('shows member artwork with Tro identity and restores Tro if the image fails', () => {
  const { container } = renderBrand('student', [school]);
  expect(screen.getByRole('img', { name: 'Our school · Tro' })).toBeTruthy();
  expect(container.querySelector('.organization-tro-badge')).not.toBeNull();
  const image = container.querySelector('.organization-brand-mark > img');
  if (!image) {
    throw new Error('Missing organization logo');
  }
  fireEvent.error(image);
  expect(container.querySelector('.organization-brand-mark')).toBeNull();
  expect(container.querySelector('.tro-icon')).not.toBeNull();
});

it('excludes directory-only and unfinished organizations from sidebar branding', () => {
  const { container } = renderBrand('admin', [
    { ...school, role: null },
    { ...school, id: '22222222-2222-4222-8222-222222222222', isNameSet: false },
  ]);
  expect(screen.getByRole('img', { name: 'Tro' })).toBeTruthy();
  expect(container.querySelector('.organization-brand-mark')).toBeNull();
});

it('lets multi-organization members choose branding and clears a removed choice', () => {
  const { update } = renderBrand('student', [
    school,
    {
      ...school,
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Other school',
      logoDataUrl: null,
    },
  ]);
  fireEvent.click(
    screen.getByRole('button', { name: 'Choose organization branding: Our school · Tro' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Other school' }));
  expect(
    screen.getByRole('button', { name: 'Choose organization branding: Other school · Tro' }),
  ).toBeTruthy();
  update('student', [school]);
  expect(screen.getByRole('img', { name: 'Our school · Tro' })).toBeTruthy();
  update('other-account', []);
  expect(screen.getByRole('img', { name: 'Tro' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Other school/ })).toBeNull();
});
