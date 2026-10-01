import type { IncomingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ModelCredentialSchema } from '#contracts/AuthSession.js';
import { readServerEnv } from '../Env.js';
import { registerModelGateway } from './RegisterModelGateway.js';

describe('model gateway', () => {
  it('requires a session and proxies a scoped credential for a signed-in user', async () => {
    const environment = readServerEnv({
      APP_ENV: 'dev',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:54329/test',
      AUTH_SECRET: 'synthetic-auth-secret-with-at-least-32-characters',
      OPENAI_API_KEY: 'synthetic-test-provider-key-0000',
    });
    const readSignedInUserId = vi
      .fn<(headers: IncomingHttpHeaders) => Promise<string | null>>()
      .mockImplementation((headers) =>
        Promise.resolve(headers.cookie === 'tro-test=session' ? 'signed-in-user' : null),
      );
    const countModelRequest = vi
      .fn<(userId: string, day: Date) => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(101);
    const api = Fastify();
    registerModelGateway(api, readSignedInUserId, countModelRequest, environment);

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
        .mockResolvedValue(new Response('{"id":"synthetic-response"}', { status: 200 }));
      try {
        const request = {
          method: 'POST' as const,
          url: '/api/v1/model/responses',
          headers: { authorization: `Bearer ${token}` },
          payload: { model: 'gpt-5.4', input: 'Hello', stream: false },
        };
        const proxied = await api.inject(request);
        expect(proxied.statusCode).toBe(200);
        expect(proxied.body).toContain('synthetic-response');
        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
        expect(countModelRequest).toHaveBeenCalledWith('signed-in-user', expect.any(Date));

        const limited = await api.inject(request);
        expect(limited.statusCode).toBe(429);
        expect(provider).toHaveBeenCalledTimes(1);
      } finally {
        provider.mockRestore();
      }
    } finally {
      await api.close();
    }
  });
});
