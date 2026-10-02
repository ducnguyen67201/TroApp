import type { IncomingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ModelCredentialSchema } from '#contracts/AuthSession.js';
import { readServerEnv } from '../Env.js';
import { registerModelGateway } from './RegisterModelGateway.js';

async function createLoggingFixture() {
  const environment = readServerEnv({
    APP_ENV: 'dev',
    DATABASE_URL: 'postgresql://private-user:private-password@127.0.0.1:54329/test',
    AUTH_SECRET: 'private-auth-secret-with-at-least-32-characters',
    OPENAI_API_KEY: 'private-provider-key-with-at-least-20-characters',
  });
  const output = new PassThrough();
  const lines: string[] = [];
  output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
  const api = Fastify();
  api.setErrorHandler((_error, _request, reply) =>
    reply.code(500).send({ message: 'Safe test response.' }),
  );
  registerModelGateway(
    api,
    () => Promise.resolve('private-user-id'),
    environment,
    pino({ level: 'debug' }, output),
  );
  const credential = await api.inject('/api/v1/model/credential');
  const body: unknown = credential.json();
  const token = ModelCredentialSchema.parse(body).token;
  return {
    api,
    token,
    readLogs: () => lines.join(''),
    sendRequest: () =>
      api.inject({
        method: 'POST',
        url: '/api/v1/model/responses',
        headers: { authorization: 'Bearer ' + token },
        payload: { model: 'gpt-5.4', input: 'private prompt and screenshot', stream: false },
      }),
  };
}

describe('model gateway', () => {
  it.each([
    { status: 400, code: 'invalid_value', type: 'invalid_request_error' },
    { status: 401, code: 'invalid_api_key', type: 'authentication_error' },
    { status: 429, code: 'insufficient_quota', type: 'insufficient_quota' },
    { status: 500, code: 'server_error', type: 'server_error' },
  ])(
    'explains provider HTTP $status errors without exposing content or changing the public response',
    async ({ status, code, type }) => {
      const fixture = await createLoggingFixture();
      const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code,
              type,
              param: 'input[4].content[0].type',
              message: 'private prompt, typed text, provider secret',
            },
          }),
          { status, headers: { 'x-request-id': 'req_synthetic-provider-id' } },
        ),
      );
      try {
        const reply = await fixture.sendRequest();
        expect(reply.statusCode).toBe(502);
        expect(reply.body).toBe(
          JSON.stringify({ message: 'The model service could not complete the request.' }),
        );
        expect(provider).toHaveBeenCalledOnce();
        const logs = fixture.readLogs();
        expect(logs).toContain('OpenAI rejected the model request.');
        expect(logs).toContain('"providerStatus":' + String(status));
        expect(logs).toContain('"providerErrorCode":"' + code + '"');
        expect(logs).toContain('"providerParameter":"input[4].content[0].type"');
        expect(logs).toContain('"providerRequestId":"req_synthetic-provider-id"');
        expect(logs).toContain(
          '"gatewayRequestId":"' + String(reply.headers['x-tro-request-id']) + '"',
        );
        expect(logs).not.toContain('private');
        expect(logs).not.toContain(fixture.token);
      } finally {
        provider.mockRestore();
        await fixture.api.close();
      }
    },
  );

  it('shows the safe network cause rather than hiding it behind a generic 502', async () => {
    const fixture = await createLoggingFixture();
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('private URL and secret', {
        cause: { code: 'ECONNRESET', message: 'private network detail' },
      }),
    );
    try {
      expect((await fixture.sendRequest()).statusCode).toBe(502);
      expect(provider).toHaveBeenCalledTimes(2);
      const logs = fixture.readLogs();
      expect(logs).toContain('Could not obtain a model response from OpenAI.');
      expect(logs).toContain('"networkCode":"ECONNRESET"');
      expect(logs).toContain('"reason":"provider_network_failed"');
      expect(logs).toContain('"event":"model.gateway.retry"');
      expect(logs).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('recovers a socket failure without starting another gateway or SDK request', async () => {
    const fixture = await createLoggingFixture();
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('private', { cause: { code: 'UND_ERR_SOCKET' } }))
      .mockResolvedValueOnce(new Response('{"id":"recovered"}'));
    try {
      const reply = await fixture.sendRequest();
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe('{"id":"recovered"}');
      expect(provider).toHaveBeenCalledTimes(2);
      expect(provider.mock.calls[0]?.[1]?.body).toBe(provider.mock.calls[1]?.[1]?.body);
      const logs = fixture.readLogs();
      expect(logs).toContain('Retrying the model request after a temporary socket failure.');
      expect(logs).toContain('"attemptNumber":2');
      expect(logs).toContain('model.gateway.completed');
      expect(logs).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('explains credential rejections without dispatching upstream', async () => {
    const fixture = await createLoggingFixture();
    const provider = vi.spyOn(globalThis, 'fetch');
    try {
      const denied = await fixture.api.inject({
        method: 'POST',
        url: '/api/v1/model/responses',
        payload: { model: 'gpt-5.4', input: 'private prompt' },
      });
      expect(denied.statusCode).toBe(401);
      expect(provider).not.toHaveBeenCalled();
      expect(fixture.readLogs()).toContain('"reason":"credential_required"');
      expect(fixture.readLogs()).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('preserves a successful response stream and logs completion without its contents', async () => {
    const fixture = await createLoggingFixture();
    const body = 'data: private model answer\n\ndata: [DONE]\n\n';
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_synthetic-success' },
      }),
    );
    try {
      const reply = await fixture.sendRequest();
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe(body);
      expect(reply.headers['content-type']).toBe('text/event-stream');
      expect(reply.headers['x-tro-request-id']).toBeDefined();
      expect(fixture.readLogs()).toContain(
        'Finished forwarding the model response to the desktop.',
      );
      expect(fixture.readLogs()).toContain('"responseBytes":' + String(Buffer.byteLength(body)));
      expect(fixture.readLogs()).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('logs mid-stream provider failure without declaring completion', async () => {
    const fixture = await createLoggingFixture();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private stream content'));
      },
    });
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
    try {
      await fixture.sendRequest();
      expect(fixture.readLogs()).toContain('"reason":"provider_stream_failed"');
      expect(fixture.readLogs()).not.toContain('model.gateway.completed');
      expect(fixture.readLogs()).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });
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
