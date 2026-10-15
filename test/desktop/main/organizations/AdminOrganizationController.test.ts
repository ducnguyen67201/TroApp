import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AdminOrganization } from '#contracts/AdminOrganization.js';
import { OrganizationAction, type OrganizationReply } from '#contracts/Organizations.js';
import { AdminOrganizationController } from '../../../../src/desktop/main/organizations/AdminOrganizationController.js';
import type { OrganizationApiClient } from '../../../../src/desktop/main/organizations/OrganizationApiClient.js';

it('scopes organization resources, keeps the admin cookie and clears context on account changes', async () => {
  const organization = { id: randomUUID(), name: 'School', ownerUserId: 'owner' };
  const execute = vi
    .fn<OrganizationApiClient['execute']>()
    .mockResolvedValue({ kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION, organization });
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response('{}')));
  const reset = vi.fn<() => void>();
  let cookie = 'admin-cookie';
  const controller = new AdminOrganizationController({ execute }, () => cookie, reset, request);
  await controller.selectOrganization(organization.id);
  await controller.fetch('https://example.test/api/v1/classroom/command', { headers: { cookie } });
  const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
  expect(headers.get(AdminOrganization.HEADER)).toBe(organization.id);
  expect(headers.get('cookie')).toBe('admin-cookie');
  await controller.fetch('https://example.test/api/auth/session', { headers: { cookie } });
  expect(new Headers(request.mock.calls[1]?.[1]?.headers).has(AdminOrganization.HEADER)).toBe(
    false,
  );
  cookie = 'another-account';
  await controller.fetch('https://example.test/api/v1/classroom/command');
  expect(new Headers(request.mock.calls[2]?.[1]?.headers).has(AdminOrganization.HEADER)).toBe(
    false,
  );
  expect(reset).toHaveBeenCalledTimes(2);
});

it('discards late selections and late data, and permits exiting after revocation or outage', async () => {
  let finishSelection: (value: OrganizationReply) => void = () => {
    throw new Error('Selection not started');
  };
  const execute = vi.fn<OrganizationApiClient['execute']>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finishSelection = resolve;
      }),
  );
  let finishRequest: (value: Response) => void = () => {
    throw new Error('Request not started');
  };
  const request = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finishRequest = resolve;
      }),
  );
  const controller = new AdminOrganizationController(
    { execute },
    () => 'cookie',
    () => {},
    request,
  );
  const organization = { id: randomUUID(), name: 'School', ownerUserId: 'owner' };
  const pending = controller.selectOrganization(organization.id);
  controller.reset();
  finishSelection({ kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION, organization });
  expect((await pending).kind).toBe('failed');
  const stale = controller.fetch('https://example.test/api/v1/lesson-videos');
  const rejected = expect(stale).rejects.toThrow('Organization changed');
  await controller.selectOrganization(null);
  finishRequest(new Response('{}'));
  await rejected;
  expect(execute).toHaveBeenCalledTimes(1);
});
