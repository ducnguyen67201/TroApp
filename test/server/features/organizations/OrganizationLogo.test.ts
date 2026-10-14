import { expect, it } from 'vitest';
import { OrganizationAction, OrganizationFailure } from '#contracts/Organizations.js';
import { OrganizationError } from '../../../../src/server/features/organizations/domain/OrganizationError.js';
import { validateAndFormatOrganizationLogo } from '../../../../src/server/features/organizations/application/OrganizationLogo.js';
import { createOrganizationFixture } from './OrganizationFixtures.js';
import {
  organizationLogo,
  organizationLogoWithMetadata,
  organizationLogoWrongDimensions,
  organizationLogoInvalidFilter,
  organizationLogoExcessPixels,
  organizationLogoRgb,
} from './OrganizationLogoFixtures.js';

it('validates static PNG pixels and strips image metadata before persistence', () => {
  const saved = validateAndFormatOrganizationLogo(organizationLogoWithMetadata);
  expect(saved).toBe(validateAndFormatOrganizationLogo(organizationLogo));
  expect(Buffer.from(saved.slice(22), 'base64').toString('latin1')).not.toContain(
    'private-image-metadata',
  );
  expect(validateAndFormatOrganizationLogo(saved)).toBe(saved);
  expect(validateAndFormatOrganizationLogo(organizationLogoRgb)).toMatch(
    /^data:image\/png;base64,/,
  );
});

it('rejects corrupt, oversized, truncated, executable and decompression-overrun images', () => {
  const corrupt = Buffer.from(organizationLogo.slice(22), 'base64');
  corrupt[29] = (corrupt[29] ?? 0) ^ 1;
  for (const logo of [
    organizationLogoWrongDimensions,
    organizationLogoInvalidFilter,
    organizationLogoExcessPixels,
    `data:image/png;base64,${corrupt.toString('base64')}`,
    organizationLogo.slice(0, -8),
    `${organizationLogo}AAAA`,
    'data:image/png;base64,' + Buffer.from('<svg onload="alert(1)" />').toString('base64'),
    'data:image/png;base64,' + 'a'.repeat(140_000),
    'https://example.test/logo.png',
  ]) {
    expect(() => validateAndFormatOrganizationLogo(logo)).toThrow(
      new OrganizationError(OrganizationFailure.INVALID),
    );
  }
});

it('lets only the current owner replace and remove logos without changing the permanent name', async () => {
  const { service, store, owner, member, admin, stranger, organization } =
    await createOrganizationFixture();
  const command = {
    kind: OrganizationAction.SET_LOGO,
    organizationId: organization.id,
    logoDataUrl: organizationLogoWithMetadata,
  };
  for (const account of [member, admin, stranger]) {
    await expect(service.execute(account.id, command)).rejects.toEqual(
      new OrganizationError(OrganizationFailure.FORBIDDEN),
    );
  }
  await service.execute(owner.id, command);
  expect(await store.readOrganization(organization.id)).toMatchObject({
    name: organization.name,
    logoDataUrl: validateAndFormatOrganizationLogo(organizationLogo),
  });
  await service.execute(owner.id, { ...command, logoDataUrl: organizationLogo });
  await service.execute(owner.id, { ...command, logoDataUrl: null });
  expect(await store.readOrganization(organization.id)).toMatchObject({
    name: organization.name,
    logoDataUrl: null,
  });
  store.organizations.set(organization.id, { ...organization, isNameSet: false });
  await expect(service.execute(owner.id, command)).rejects.toEqual(
    new OrganizationError(OrganizationFailure.CONFLICT),
  );
});
