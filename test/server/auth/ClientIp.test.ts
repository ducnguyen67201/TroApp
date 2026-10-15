import { expect, it } from 'vitest';
import { createApi } from '../../../src/server/CreateApi.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createAuthDatabase } from '../../../src/server/persistence/AuthDatabase.js';
import { registerAuthRoutes } from '../../../src/server/auth/RegisterAuthRoutes.js';

it('limits auth requests by the Railway client IP and ignores other forwarded IPs', async () => {
  const environment = readServerEnv({
    DATABASE_URL: 'postgresql://tro:synthetic@127.0.0.1:1/tro_test',
    AUTH_SECRET: 'synthetic-client-ip-test-secret-0000000000',
  });
  const authentication = createAuthDatabase(environment);
  const context = await authentication.auth.$context;
  context.rateLimit.enabled = true;
  context.rateLimit.max = 1;
  context.rateLimit.window = 60;
  const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });
  registerAuthRoutes(api, authentication.auth, environment.AUTH_BASE_URL);

  try {
    const first = await api.inject({
      url: '/api/auth/get-session',
      headers: { 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '203.0.113.1' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe('null');

    const repeated = await api.inject({
      url: '/api/auth/get-session',
      headers: { 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '203.0.113.2' },
    });
    expect(repeated.statusCode).toBe(429);

    const otherClient = await api.inject({
      url: '/api/auth/get-session',
      headers: { 'x-real-ip': '192.0.2.2', 'x-forwarded-for': '203.0.113.2' },
    });
    expect(otherClient.statusCode).toBe(200);
    expect(otherClient.body).toBe('null');
  } finally {
    await api.close();
    await authentication.close();
  }
});
