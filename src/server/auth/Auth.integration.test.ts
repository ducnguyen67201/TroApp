import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ModelCredentialSchema } from '#contracts/AuthSession.js';
import { createApi } from '../CreateApi.js';
import { readServerEnv } from '../Env.js';
import { createPrismaDatabaseStatus } from '../persistence/PrismaDatabaseStatus.js';
import { createAuthDatabase } from '../persistence/AuthDatabase.js';
import { registerAuthRoutes } from './RegisterAuthRoutes.js';
import { registerModelGateway } from './RegisterModelGateway.js';

describe('Tro account and scoped model credential', () => {
  it('starts Google OAuth in the system browser without contacting Google yet', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const listener = createServer();
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (!address || typeof address === 'string') {
          listener.close();
          reject(new Error('Could not reserve a local OAuth test port.'));
          return;
        }
        listener.close(() => {
          resolve(address.port);
        });
      });
    });
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const environment = readServerEnv({
      ...process.env,
      APP_ENV: 'dev',
      AUTH_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: 'synthetic-google-client-id',
      GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret',
    });
    const database = createPrismaDatabaseStatus(environment.DATABASE_URL, { debug() {} });
    const authentication = createAuthDatabase(environment);
    const api = createApi(database);
    registerAuthRoutes(api, authentication.auth, baseUrl, true);

    try {
      await api.listen({ host: '127.0.0.1', port });
      const response = await fetch(
        `${baseUrl}/api/auth/electron/init-oauth-proxy?provider=google&state=teststate&code_challenge=testchallenge`,
        { redirect: 'manual' },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('accounts.google.com');
    } finally {
      await api.close();
      await authentication.close();
      await database.close();
    }
  });

  it('signs up, restores the cookie, and rejects a credential without login', async () => {
    const environment = readServerEnv({
      ...process.env,
      OPENAI_API_KEY: 'synthetic-test-provider-key-0000',
      GOOGLE_CLIENT_ID: 'synthetic-google-client-id',
      GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret',
    });
    const database = createPrismaDatabaseStatus(environment.DATABASE_URL, { debug() {} });
    const authentication = createAuthDatabase(environment);
    const api = createApi(database);
    registerAuthRoutes(api, authentication.auth, environment.AUTH_BASE_URL, true);
    registerModelGateway(api, authentication.auth, authentication.countModelRequest, environment);

    try {
      const google = await api.inject('/api/v1/auth/google');
      expect(google.json()).toEqual({ available: true });
      const returnPage = await api.inject('/');
      expect(returnPage.body).toContain('app.tro.desktop://auth/callback#token=');

      const denied = await api.inject('/api/v1/model/credential');
      expect(denied.statusCode).toBe(401);

      const signup = await api.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { origin: environment.AUTH_BASE_URL },
        payload: {
          name: 'Integration Student',
          email: `student-${randomUUID()}@example.test`,
          password: 'synthetic-password-12345',
        },
      });
      expect(signup.statusCode).toBe(200);
      const rawCookie = signup.headers['set-cookie'];
      const cookie = (Array.isArray(rawCookie) ? rawCookie : [rawCookie])
        .find((value) => value?.includes('session_token'))
        ?.split(';', 1)[0];
      expect(cookie).toBeTruthy();

      const credential = await api.inject({
        method: 'GET',
        url: '/api/v1/model/credential',
        headers: { cookie: cookie ?? '' },
      });
      expect(credential.statusCode).toBe(200);
      const credentialBody: unknown = credential.json();
      const token = ModelCredentialSchema.parse(credentialBody).token;
      expect(token.length).toBeGreaterThan(20);

      const provider = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{"id":"synthetic-response"}', { status: 200 }));
      try {
        const proxied = await api.inject({
          method: 'POST',
          url: '/api/v1/model/responses',
          headers: { authorization: `Bearer ${token}` },
          payload: { model: 'gpt-5.4', input: 'Hello', stream: false },
        });
        expect(proxied.statusCode).toBe(200);
        expect(proxied.body).toContain('synthetic-response');
        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
      } finally {
        provider.mockRestore();
      }
    } finally {
      await api.close();
      await authentication.close();
      await database.close();
    }
  });
});
