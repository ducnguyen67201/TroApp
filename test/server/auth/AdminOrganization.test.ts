import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { AdminOrganization } from '#contracts/AdminOrganization.js';
import { OrganizationAction } from '#contracts/Organizations.js';
import { registerAdminOrganization } from '../../../src/server/auth/RegisterAdminOrganization.js';
import { readAdminOrganizationId } from '../../../src/server/auth/AdminOrganizationContext.js';
import { createOrganizationFixture } from '../features/organizations/OrganizationFixtures.js';
import { ClassroomService } from '../../../src/server/features/classroom/application/ClassroomService.js';
import { MemoryClassroomStore } from '../features/classroom/ClassroomFixtures.js';

it('isolates concurrent organization scopes, preserves the actor, and denies forged or revoked authority', async () => {
  const { store, organization, admin, owner } = await createOrganizationFixture();
  const other = { ...organization, id: randomUUID(), name: 'Other organization' };
  await store.createOrganization(other);
  const api = Fastify();
  const log = { info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>() };
  registerAdminOrganization(
    api,
    (headers) => Promise.resolve(headers['actor'] === 'owner' ? owner.id : admin.id),
    store,
    log,
  );
  api.post('/api/v1/classroom/command', async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    return { actorId: admin.id, organizationId: readAdminOrganizationId(admin.id) };
  });
  try {
    const request = (organizationId: string | undefined, actor = 'admin') =>
      api.inject({
        method: 'POST',
        url: '/api/v1/classroom/command',
        headers: {
          actor,
          ...(organizationId ? { [AdminOrganization.HEADER]: organizationId } : {}),
        },
        payload: { kind: 'delete-class', classId: randomUUID() },
      });
    const responses = await Promise.all([
      request(organization.id),
      request(other.id),
      request(undefined),
    ]);
    expect(responses.map((response) => response.json<unknown>())).toEqual([
      { actorId: admin.id, organizationId: organization.id },
      { actorId: admin.id, organizationId: other.id },
      { actorId: admin.id, organizationId: null },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: admin.id,
        organizationId: organization.id,
        operation: 'delete-class',
      }),
      'organization.admin.completed',
    );
    for (const invalid of ['bad-id', randomUUID()]) {
      expect((await request(invalid)).statusCode).toBe(403);
    }
    expect((await request(organization.id, 'owner')).statusCode).toBe(403);
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/v1/classroom/command',
          headers: { 'x-tro-classroom-view-as': owner.id },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    store.accounts.set(admin.id, { ...admin, isAdmin: false });
    expect((await request(organization.id)).statusCode).toBe(403);
  } finally {
    await api.close();
  }
});

it('authorizes the organization selection without creating a membership or changing ownership', async () => {
  const { service, store, organization, admin, owner } = await createOrganizationFixture();
  const command = {
    kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION,
    organizationId: organization.id,
  } as const;
  expect(await service.execute(admin.id, command)).toEqual({
    kind: OrganizationAction.SELECT_ADMIN_ORGANIZATION,
    organization,
  });
  expect(await store.readMembership(organization.id, admin.id)).toBeNull();
  expect((await store.readOrganization(organization.id))?.ownerUserId).toBe(owner.id);
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({ code: 'forbidden' });
});

it('retires person impersonation commands even for an administrator', async () => {
  const store = new MemoryClassroomStore();
  store.admins.add('admin');
  const service = new ClassroomService(store);
  await expect(
    service.execute('admin', { kind: 'admin-view-as', userId: 'teacher' }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    service.execute('admin', { kind: 'admin-people', search: '', offset: 0 }),
  ).rejects.toMatchObject({ code: 'forbidden' });
});
