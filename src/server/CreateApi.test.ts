import { describe, expect, it } from 'vitest';
import { createApi } from './CreateApi.js';
import { SystemStatusSchema } from '#contracts/SystemStatus.js';
import type { AuthOperations } from './features/auth/AuthService.js';

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

  it('does not expose workspace data without authentication', async () => {
    const auth = {
      startGoogleSignIn: () => Promise.resolve('https://accounts.google.com/o/oauth2/v2/auth'),
      completeGoogleSignIn: () => Promise.resolve('tro://auth/callback?error=failed'),
      exchangeHandoff: () => Promise.reject(new Error('unused')),
      readSession: () => Promise.reject(new Error('must not be reached')),
      createWorkspace: () => Promise.reject(new Error('unused')),
      logout: () => Promise.resolve(),
      close: () => Promise.resolve(),
    } satisfies AuthOperations;
    const api = createApi({ isDatabaseReady: () => Promise.resolve(true) }, auth);

    try {
      const response = await api.inject('/api/v1/workspace');

      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('must not be reached');
    } finally {
      await api.close();
    }
  });
});
