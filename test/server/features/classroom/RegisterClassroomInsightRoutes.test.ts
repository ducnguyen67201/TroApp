import Fastify from 'fastify';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { InsightFailure } from '#contracts/ClassroomInsights.js';
import type { ClassroomInsightService } from '../../../../src/server/features/classroom/application/ClassroomInsightService.js';
import { ClassroomInsightError } from '../../../../src/server/features/classroom/domain/ClassroomInsightError.js';
import { registerClassroomInsightRoutes } from '../../../../src/server/features/classroom/infrastructure/RegisterClassroomInsightRoutes.js';

const classId = '00000000-0000-4000-8000-000000000001';

describe('classroom insight HTTP boundary', () => {
  it('authenticates before reading requests, rejects unknown fields and never caches sources', async () => {
    const api = Fastify();
    const execute = vi.fn<ClassroomInsightService['execute']>().mockResolvedValue({
      kind: 'status',
      enabled: false,
      teacher: true,
      students: [],
      activities: [],
      plans: [],
      mappings: [],
    });
    const warn = vi.fn<Logger['warn']>();
    let userId: string | null = null;
    registerClassroomInsightRoutes(api, () => Promise.resolve(userId), { execute }, { warn });
    try {
      const anonymous = await api.inject({
        method: 'POST',
        url: '/api/v1/classroom/insights',
        payload: { kind: 'status', classId },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');
      expect(execute).not.toHaveBeenCalled();
      userId = 'teacher';
      const malformed = await api.inject({
        method: 'POST',
        url: '/api/v1/classroom/insights',
        payload: { kind: 'status', classId, rawWork: 'sensitive student work' },
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.headers['cache-control']).toBe('no-store');
      expect(execute).not.toHaveBeenCalled();
      const accepted = await api.inject({
        method: 'POST',
        url: '/api/v1/classroom/insights',
        payload: { kind: 'status', classId },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.headers['cache-control']).toBe('no-store');
      expect(execute).toHaveBeenCalledWith('teacher', { kind: 'status', classId });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive student work');
    } finally {
      await api.close();
    }
  });

  it.each([
    [InsightFailure.FORBIDDEN, 403],
    [InsightFailure.INVALID, 400],
    [InsightFailure.STALE, 409],
    [InsightFailure.LIMIT, 429],
    [InsightFailure.REMOVED, 410],
    [InsightFailure.UNAVAILABLE, 503],
  ] as const)('returns the safe refusal %s', async (code, status) => {
    const api = Fastify();
    const execute = vi
      .fn<ClassroomInsightService['execute']>()
      .mockRejectedValue(new ClassroomInsightError(code));
    const warn = vi.fn<Logger['warn']>();
    registerClassroomInsightRoutes(api, () => Promise.resolve('teacher'), { execute }, { warn });
    try {
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/classroom/insights',
        payload: { kind: 'status', classId },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json<unknown>()).toEqual({ kind: 'failed', code });
      expect(response.headers['cache-control']).toBe('no-store');
      const loggedFields: unknown = warn.mock.calls[0]?.[0];
      expect(loggedFields).toMatchObject({ operation: 'status', code });
      expect(warn.mock.calls[0]?.[1]).toBe('classroom.insights.refused');
    } finally {
      await api.close();
    }
  });

  it('keeps parser failures private and uncached', async () => {
    const api = Fastify();
    const execute = vi.fn<ClassroomInsightService['execute']>();
    const warn = vi.fn<Logger['warn']>();
    registerClassroomInsightRoutes(api, () => Promise.resolve('teacher'), { execute }, { warn });
    try {
      const response = await api.inject({
        method: 'POST',
        url: '/api/v1/classroom/insights',
        headers: { 'content-type': 'application/json' },
        payload: '{"private student work":',
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json<unknown>()).toEqual({ kind: 'failed', code: InsightFailure.INVALID });
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private student work');
      expect(response.body).not.toContain('private student work');
    } finally {
      await api.close();
    }
  });

  it('contains unexpected service and authentication errors without raw logs', async () => {
    const api = Fastify();
    const execute = vi
      .fn<ClassroomInsightService['execute']>()
      .mockRejectedValue(new Error('private source text'));
    const warn = vi.fn<Logger['warn']>();
    let failAuthentication = false;
    registerClassroomInsightRoutes(
      api,
      () => {
        if (failAuthentication) {
          return Promise.reject(new Error('private authentication text'));
        }
        return Promise.resolve('teacher');
      },
      { execute },
      { warn },
    );
    try {
      const request = {
        method: 'POST' as const,
        url: '/api/v1/classroom/insights',
        payload: { kind: 'status', classId },
      };
      expect((await api.inject(request)).statusCode).toBe(503);
      failAuthentication = true;
      const response = await api.inject(request);
      expect(response.statusCode).toBe(503);
      expect(response.json<unknown>()).toEqual({
        kind: 'failed',
        code: InsightFailure.UNAVAILABLE,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
      expect(response.body).not.toContain('private');
    } finally {
      await api.close();
    }
  });
});
