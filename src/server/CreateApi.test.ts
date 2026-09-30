import { describe, expect, it } from 'vitest';
import { createApi } from './CreateApi.js';
import { SystemStatusSchema } from '#contracts/SystemStatus.js';

describe('service routes', () => {
  it('reports a migrated database as ready', async () => {
    const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });

    try {
      const response = await api.inject({ method: 'GET', url: '/api/v1/system/status' });
      const body: unknown = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(SystemStatusSchema.parse(body).database).toBe('ready');
    } finally {
      await api.close();
    }
  });

  it('keeps liveness available while readiness fails', async () => {
    const api = createApi({ isDatabaseReady: () => Promise.resolve(false) });

    try {
      expect((await api.inject('/health/live')).statusCode).toBe(200);
      expect((await api.inject('/health/ready')).statusCode).toBe(503);
    } finally {
      await api.close();
    }
  });

  it('does not reveal adapter errors in responses', async () => {
    const api = createApi({
      isDatabaseReady: () => Promise.reject(new Error('sensitive database details')),
    });

    try {
      const response = await api.inject('/api/v1/system/status');

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('sensitive');
    } finally {
      await api.close();
    }
  });
});
