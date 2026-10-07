import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerPracticeCheckRoutes } from '../../../../src/server/features/classroom/infrastructure/RegisterPracticeCheckRoutes.js';
import { PracticeCheckService } from '../../../../src/server/features/classroom/application/PracticeCheckService.js';
import { MemoryPracticeStore } from './PracticeFixtures.js';
it('requires authentication, rejects untrusted body fields, and logs no raw work', async () => {
  const store = new MemoryPracticeStore();
  const api = Fastify();
  let userId: string | null = null;
  const warn = vi.fn();
  const service = new PracticeCheckService(
    store,
    { available: false, version: 'fake', evaluate: () => Promise.reject(new Error('Unavailable')) },
    { dailyChecks: 1, minuteChecks: 1 },
  );
  registerPracticeCheckRoutes(api, () => Promise.resolve(userId), service, { warn });
  try {
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/v1/classroom/practice',
          payload: { kind: 'history' },
        })
      ).statusCode,
    ).toBe(401);
    userId = 'student';
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/v1/classroom/practice',
          payload: { kind: 'history', secret: 'do not log' },
        })
      ).statusCode,
    ).toBe(400);
    userId = 'other';
    const result = await api.inject({
      method: 'POST',
      url: '/api/v1/classroom/practice',
      payload: {
        kind: 'history',
        participationId: store.access.participationId,
        deviceId: store.access.deviceId,
        activityId: store.access.activity.id,
      },
    });
    expect(result.statusCode).toBe(403);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('do not log');
    expect(result.headers['cache-control']).toBe('no-store');
  } finally {
    await api.close();
  }
});
