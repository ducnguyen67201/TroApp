import type { IncomingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ModelCredentialSchema } from '#contracts/AuthSession.js';
import { readServerEnv } from '../Env.js';
import { registerModelGateway } from './RegisterModelGateway.js';

describe('model gateway', () => {
  it.each(['dev', 'stage', 'prod'] as const)(
    'forwards more than 100 requests in %s while requiring valid credentials',
    async (appEnvironment) => {
      const environment = readServerEnv({
        APP_ENV: appEnvironment,
        AUTH_BASE_URL: 'https://api.example.test',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:54329/test',
        AUTH_SECRET: 'synthetic-auth-secret-with-at-least-32-characters',
        OPENAI_API_KEY: 'synthetic-test-provider-key-0000',
      });
      const readSignedInUserId = vi
        .fn<(headers: IncomingHttpHeaders) => Promise<string | null>>()
        .mockImplementation((headers) =>
          Promise.resolve(headers.cookie === 'tro-test=session' ? 'signed-in-user' : null),
        );
      const api = Fastify();
      registerModelGateway(api, readSignedInUserId, environment);

      try {
        const denied = await api.inject('/api/v1/model/credential');
        expect(denied.statusCode).toBe(401);

        const credential = await api.inject({
          method: 'GET',
          url: '/api/v1/model/credential',
          headers: { cookie: 'tro-test=session' },
        });
        expect(credential.statusCode).toBe(200);
        expect(credential.headers['cache-control']).toBe('no-store');
        const credentialBody: unknown = credential.json();
        const token = ModelCredentialSchema.parse(credentialBody).token;

        const provider = vi
          .spyOn(globalThis, 'fetch')
          .mockImplementation(() =>
            Promise.resolve(new Response('{"id":"synthetic-response"}', { status: 200 })),
          );
        try {
          const request = {
            method: 'POST' as const,
            url: '/api/v1/model/responses',
            headers: { authorization: `Bearer ${token}` },
            payload: { model: 'gpt-5.4', input: 'Hello', stream: false },
          };
          const missingCredential = await api.inject({ ...request, headers: {} });
          expect(missingCredential.statusCode).toBe(401);
          const invalidCredential = await api.inject({
            ...request,
            headers: { authorization: 'Bearer invalid-token' },
          });
          expect(invalidCredential.statusCode).toBe(401);
          const invalidModel = await api.inject({
            ...request,
            payload: { ...request.payload, model: 'unsupported-model' },
          });
          expect(invalidModel.statusCode).toBe(400);
          expect(provider).not.toHaveBeenCalled();

          /* Cross the former daily cap using synthetic provider responses only. */
          for (let requestIndex = 0; requestIndex < 105; requestIndex += 1) {
            const proxied = await api.inject(request);
            expect(proxied.statusCode).toBe(200);
            expect(proxied.body).toContain('synthetic-response');
          }
          expect(provider).toHaveBeenCalledTimes(105);
          expect(provider.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
        } finally {
          provider.mockRestore();
        }
      } finally {
        await api.close();
      }
    },
  );
});
