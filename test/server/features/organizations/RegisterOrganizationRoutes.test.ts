import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { OrganizationAction, OrganizationFailure } from '#contracts/Organizations.js';
import type { OrganizationService } from '../../../../src/server/features/organizations/application/OrganizationService.js';
import { OrganizationError } from '../../../../src/server/features/organizations/domain/OrganizationError.js';
import { registerOrganizationRoutes } from '../../../../src/server/features/organizations/infrastructure/RegisterOrganizationRoutes.js';

it('checks sessions and strict input, validates replies and logs safe failure metadata', async () => {
  const api = Fastify({ genReqId: () => 'organization-route-test' });
  const execute = vi.fn<OrganizationService['execute']>().mockResolvedValue({
    kind: 'home',
    organizations: [],
    isAdmin: false,
  });
  const log = {
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
  registerOrganizationRoutes(
    api,
    (headers) => Promise.resolve(headers.cookie === 'session=ok' ? 'user' : null),
    { execute },
    log,
  );
  try {
    const request = {
      method: 'POST' as const,
      url: '/api/v1/organizations/command',
      payload: { kind: OrganizationAction.HOME },
    };
    expect((await api.inject(request)).statusCode).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    expect(
      (
        await api.inject({
          ...request,
          headers: { cookie: 'session=ok' },
          payload: { kind: OrganizationAction.HOME, isAdmin: true },
        })
      ).statusCode,
    ).toBe(400);
    const success = await api.inject({ ...request, headers: { cookie: 'session=ok' } });
    expect(success.statusCode).toBe(200);
    expect(success.headers['cache-control']).toBe('no-store');
    expect(execute).toHaveBeenCalledWith('user', { kind: OrganizationAction.HOME });
    execute.mockRejectedValue(new OrganizationError(OrganizationFailure.FORBIDDEN));
    const refused = await api.inject({ ...request, headers: { cookie: 'session=ok' } });
    expect(refused.statusCode).toBe(403);
    expect(log.warn).toHaveBeenLastCalledWith(
      {
        operation: OrganizationAction.HOME,
        code: OrganizationFailure.FORBIDDEN,
        requestId: 'organization-route-test',
      },
      'organization.command.refused',
    );
    execute.mockRejectedValue(new Error('private-invitation-secret@example.test'));
    expect((await api.inject({ ...request, headers: { cookie: 'session=ok' } })).statusCode).toBe(
      503,
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private-invitation-secret');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('private-invitation-secret');
  } finally {
    await api.close();
  }
});

it('bounds copied invitation attempts before calling the service', async () => {
  const api = Fastify();
  const execute = vi
    .fn<OrganizationService['execute']>()
    .mockRejectedValue(new OrganizationError(OrganizationFailure.FORBIDDEN));
  registerOrganizationRoutes(
    api,
    () => Promise.resolve('user'),
    { execute },
    { warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() },
  );
  try {
    const request = {
      method: 'POST' as const,
      url: '/api/v1/organizations/command',
      payload: { kind: OrganizationAction.ACCEPT_INVITATION, code: 'A'.repeat(43) },
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await api.inject(request)).statusCode).toBe(403);
    }
    expect((await api.inject(request)).statusCode).toBe(429);
    expect(execute).toHaveBeenCalledTimes(10);
  } finally {
    await api.close();
  }
});

it('admits bounded logo bodies larger than the former command limit', async () => {
  const api = Fastify();
  const execute = vi.fn<OrganizationService['execute']>().mockResolvedValue({ kind: 'ok' });
  const log = { warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() };
  registerOrganizationRoutes(api, () => Promise.resolve('owner'), { execute }, log);
  try {
    const command = {
      kind: OrganizationAction.SET_LOGO,
      organizationId: '11111111-1111-4111-8111-111111111111',
      logoDataUrl: 'data:image/png;base64,' + 'A'.repeat(8192),
    };
    expect(
      (await api.inject({ method: 'POST', url: '/api/v1/organizations/command', payload: command }))
        .statusCode,
    ).toBe(200);
    expect(execute).toHaveBeenCalledWith('owner', command);
  } finally {
    await api.close();
  }
});
