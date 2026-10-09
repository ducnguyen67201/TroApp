import {
  ModelAbortSource,
  ModelFailureStage,
  ModelRequestTraceHeader,
  readModelGatewayDiagnostics,
} from '#contracts/ModelGatewayError.js';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { Socket } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { ModelCredentialSchema } from '#contracts/AuthSession.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { registerModelGateway } from '../../../src/server/auth/RegisterModelGateway.js';
import { ModelGatewayEvent } from '../../../src/server/auth/ModelGatewayDiagnostics.js';
import { ModelGatewayConfig } from '../../../src/server/auth/ModelGatewayConfig.js';

function readLogEvents(logs: string): Record<string, unknown>[] {
  return logs
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const event: unknown = JSON.parse(line);
      return z.record(z.string(), z.unknown()).parse(event);
    });
}

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
    readEvents: () => readLogEvents(lines.join('')),
    sendRequest: (fields: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
      api.inject({
        method: 'POST',
        url: '/api/v1/model/responses',
        headers: { authorization: 'Bearer ' + token, ...headers },
        payload: {
          model: 'gpt-5.4',
          input: 'private prompt and screenshot',
          stream: false,
          ...fields,
        },
      }),
  };
}

describe('model gateway', () => {
  it('traces admission, provider response and HTTP delivery for a valid request identity', async () => {
    const fixture = await createLoggingFixture();
    const modelRequestId = randomUUID();
    const chunks = ['data: private model answer\n\n', 'data: [DONE]\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': 'req_synthetic-lifecycle',
          'x-private-provider-detail': 'private response header',
        },
      }),
    );
    try {
      const reply = await fixture.sendRequest(
        { stream: true },
        { [ModelRequestTraceHeader]: modelRequestId },
      );
      expect(reply.statusCode).toBe(200);
      expect(reply.headers[ModelRequestTraceHeader]).toBe(modelRequestId);
      expect(reply.body).toBe(chunks.join(''));
      const events = fixture.readEvents();
      const lifecycleEvents = new Set<string>([
        ModelGatewayEvent.REQUEST,
        ModelGatewayEvent.ADMITTED,
        ModelGatewayEvent.DISPATCH,
        ModelGatewayEvent.PROVIDER_HEADERS,
        ModelGatewayEvent.FIRST_CHUNK,
        ModelGatewayEvent.COMPLETED,
        ModelGatewayEvent.DELIVERED,
      ]);
      expect(
        events
          .filter((entry) => typeof entry.event === 'string' && lifecycleEvents.has(entry.event))
          .map((entry) => entry.event),
      ).toEqual([
        ModelGatewayEvent.REQUEST,
        ModelGatewayEvent.ADMITTED,
        ModelGatewayEvent.DISPATCH,
        ModelGatewayEvent.PROVIDER_HEADERS,
        ModelGatewayEvent.FIRST_CHUNK,
        ModelGatewayEvent.COMPLETED,
        ModelGatewayEvent.DELIVERED,
      ]);
      for (const event of events) {
        expect(event).toMatchObject({
          modelRequestId,
          gatewayRequestId: reply.headers['x-tro-request-id'],
        });
      }
      const forwardedBody = provider.mock.calls[0]?.[1]?.body;
      if (typeof forwardedBody !== 'string') {
        throw new Error('The provider fixture did not receive a serialized body.');
      }
      expect(events.find((entry) => entry.event === ModelGatewayEvent.DISPATCH)).toMatchObject({
        requestBytes: Buffer.byteLength(forwardedBody),
        model: 'gpt-5.4',
        stream: true,
      });
      expect(
        events.find((entry) => entry.event === ModelGatewayEvent.PROVIDER_HEADERS),
      ).toMatchObject({
        providerStatus: 200,
        providerRequestId: 'req_synthetic-lifecycle',
      });
      const completion = events.find((entry) => entry.event === ModelGatewayEvent.COMPLETED);
      expect(completion).toMatchObject({
        responseBytes: Buffer.byteLength(chunks.join('')),
        responseChunks: chunks.length,
        backpressureWaits: 0,
        backpressureDurationMs: 0,
      });
      const firstChunkMs = completion?.firstChunkAfterDispatchMs;
      const lastChunkMs = completion?.lastChunkAfterDispatchMs;
      if (typeof firstChunkMs !== 'number' || typeof lastChunkMs !== 'number') {
        throw new Error('The completed stream did not retain chunk timing.');
      }
      expect(firstChunkMs).toBeGreaterThanOrEqual(0);
      expect(lastChunkMs).toBeGreaterThanOrEqual(firstChunkMs);
      const delivery = events.find((entry) => entry.event === ModelGatewayEvent.DELIVERED);
      expect(delivery).toMatchObject({ status: 200 });
      /* Fastify's in-memory injector does not model native writable finish state. */
      expect(typeof delivery?.responseFinished).toBe('boolean');
      expect(fixture.readLogs()).not.toContain('private');
      expect(fixture.readLogs()).not.toContain(fixture.token);
      expect(fixture.readLogs()).not.toContain('x-private-provider-detail');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('retains a valid request identity in both a gateway failure and its delivery event', async () => {
    const fixture = await createLoggingFixture();
    const modelRequestId = randomUUID();
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('private network detail', {
        cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo' },
      }),
    );
    try {
      const reply = await fixture.sendRequest({}, { [ModelRequestTraceHeader]: modelRequestId });
      expect(reply.statusCode).toBe(502);
      expect(reply.headers[ModelRequestTraceHeader]).toBe(modelRequestId);
      const body: unknown = reply.json();
      expect(readModelGatewayDiagnostics(body)).toMatchObject({
        modelRequestId,
        gatewayRequestId: reply.headers['x-tro-request-id'],
        networkCode: 'ENOTFOUND',
      });
      const events = fixture.readEvents();
      expect(events.find((entry) => entry.event === ModelGatewayEvent.FAILED)).toMatchObject({
        modelRequestId,
      });
      expect(events.find((entry) => entry.event === ModelGatewayEvent.DELIVERED)).toMatchObject({
        modelRequestId,
        status: 502,
      });
      expect(fixture.readLogs()).not.toContain('private');
      expect(reply.body).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('ignores an invalid request identity instead of logging or echoing its value', async () => {
    const fixture = await createLoggingFixture();
    const invalidTrace = 'private unvalidated trace value';
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      const reply = await fixture.sendRequest({}, { [ModelRequestTraceHeader]: invalidTrace });
      expect(reply.statusCode).toBe(200);
      expect(reply.headers[ModelRequestTraceHeader]).toBeUndefined();
      for (const event of fixture.readEvents()) {
        expect(event).not.toHaveProperty('modelRequestId');
      }
      expect(fixture.readLogs()).not.toContain(invalidTrace);
      expect(reply.body).not.toContain(invalidTrace);
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('logs arrival before schema rejection without admitting or dispatching the request', async () => {
    const fixture = await createLoggingFixture();
    const provider = vi.spyOn(globalThis, 'fetch');
    try {
      const reply = await fixture.sendRequest({ model: 'private unsupported model' });
      expect(reply.statusCode).toBe(400);
      expect(provider).not.toHaveBeenCalled();
      expect(fixture.readEvents().map((entry) => entry.event)).toEqual([
        ModelGatewayEvent.REQUEST,
        ModelGatewayEvent.REJECTED,
        ModelGatewayEvent.DELIVERED,
      ]);
      expect(
        fixture.readEvents().find((entry) => entry.event === ModelGatewayEvent.REJECTED),
      ).toMatchObject({
        reason: 'request_invalid',
        status: 400,
      });
      expect(fixture.readLogs()).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('logs malformed JSON at the body stage after arrival without copying its content', async () => {
    const fixture = await createLoggingFixture();
    const provider = vi.spyOn(globalThis, 'fetch');
    try {
      await fixture.api.inject({
        method: 'POST',
        url: '/api/v1/model/responses',
        headers: {
          authorization: 'Bearer ' + fixture.token,
          'content-type': 'application/json',
        },
        payload: '{ private malformed body',
      });
      expect(provider).not.toHaveBeenCalled();
      expect(fixture.readEvents().map((entry) => entry.event)).toEqual([
        ModelGatewayEvent.REQUEST,
        ModelGatewayEvent.REJECTED,
        ModelGatewayEvent.DELIVERED,
      ]);
      expect(
        fixture.readEvents().find((entry) => entry.event === ModelGatewayEvent.REJECTED),
      ).toMatchObject({
        stage: 'request_body',
        errorCode: 'FST_ERR_CTP_INVALID_JSON_BODY',
        status: 400,
      });
      expect(fixture.readLogs()).not.toContain('private');
      expect(fixture.readLogs()).not.toContain(fixture.token);
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('records the deadline as the first abort source and stops without retrying', async () => {
    const fixture = await createLoggingFixture();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
      const signal = options?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('The provider fixture did not receive cancellation.');
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('private deadline detail', 'TimeoutError'));
          },
          { once: true },
        );
        deadline.abort(new DOMException('private cancellation detail', 'TimeoutError'));
      });
    });
    try {
      const reply = await fixture.sendRequest();
      expect(reply.statusCode).toBe(502);
      expect(timeout).toHaveBeenCalledWith(ModelGatewayConfig.requestTimeoutMs);
      expect(provider).toHaveBeenCalledOnce();
      const events = fixture.readEvents();
      expect(events.filter((entry) => entry.event === ModelGatewayEvent.ABORTED)).toEqual([
        expect.objectContaining({ abortSource: ModelAbortSource.DEADLINE }),
      ]);
      expect(events.find((entry) => entry.event === ModelGatewayEvent.FAILED)).toMatchObject({
        abortSource: ModelAbortSource.DEADLINE,
        timedOut: true,
        failureStage: ModelFailureStage.DEADLINE,
      });
      expect(events.some((entry) => entry.event === ModelGatewayEvent.RETRY)).toBe(false);
      expect(
        events
          .filter((entry) => entry.event === ModelGatewayEvent.ATTEMPT)
          .map((entry) => [entry.attemptNumber, entry.phase]),
      ).toEqual([
        [1, 'started'],
        [1, 'failed'],
      ]);
      const body: unknown = reply.json();
      expect(readModelGatewayDiagnostics(body)).toMatchObject({
        abortSource: ModelAbortSource.DEADLINE,
        timedOut: true,
        failureStage: ModelFailureStage.DEADLINE,
        attemptNumber: 1,
      });
      expect(fixture.readLogs()).not.toContain('private');
      expect(reply.body).not.toContain('private');
    } finally {
      provider.mockRestore();
      timeout.mockRestore();
      await fixture.api.close();
    }
  });

  it('forwards visual requests directly without a token-count preflight', async () => {
    const fixture = await createLoggingFixture();
    const input = [
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,synthetic' }],
      },
    ];
    const tools = [{ type: 'function', name: 'read', parameters: { type: 'object' } }];
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"id":"direct"}'));
    try {
      const reply = await fixture.sendRequest({
        input,
        tools,
        instructions: 'Synthetic instruction',
        store: false,
      });
      expect(reply.statusCode).toBe(200);
      expect(provider).toHaveBeenCalledOnce();
      expect(provider.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
      expect(provider.mock.calls[0]?.[1]?.body).toBe(
        JSON.stringify({
          model: 'gpt-5.4',
          input,
          stream: false,
          tools,
          instructions: 'Synthetic instruction',
          store: false,
          max_output_tokens: 4096,
        }),
      );
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it.each([
    { requested: undefined, expected: 4096 },
    { requested: 1024, expected: 1024 },
    { requested: 10000, expected: 4096 },
  ])(
    'applies the configured output ceiling for $requested tokens',
    async ({ requested, expected }) => {
      const fixture = await createLoggingFixture();
      const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
      try {
        const reply = await fixture.sendRequest(
          requested === undefined ? {} : { max_output_tokens: requested },
        );
        expect(reply.statusCode).toBe(200);
        expect(provider.mock.calls[0]?.[1]?.body).toContain(
          '"max_output_tokens":' + String(expected),
        );
      } finally {
        provider.mockRestore();
        await fixture.api.close();
      }
    },
  );

  it.each([0, -1, 1.5, '4096'])(
    'rejects invalid output limits (%s) before forwarding',
    async (requested) => {
      const fixture = await createLoggingFixture();
      const provider = vi.spyOn(globalThis, 'fetch');
      try {
        expect((await fixture.sendRequest({ max_output_tokens: requested })).statusCode).toBe(400);
        expect(provider).not.toHaveBeenCalled();
      } finally {
        provider.mockRestore();
        await fixture.api.close();
      }
    },
  );

  it.each([
    { status: 400, code: 'invalid_value', type: 'invalid_request_error' },
    { status: 400, code: 'context_length_exceeded', type: 'invalid_request_error' },
    { status: 401, code: 'invalid_api_key', type: 'authentication_error' },
    { status: 429, code: 'insufficient_quota', type: 'insufficient_quota' },
    { status: 500, code: 'server_error', type: 'server_error' },
  ])(
    'explains provider HTTP $status errors without exposing content and preserves diagnostics in the response',
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
        const responseBody: unknown = reply.json();
        expect(readModelGatewayDiagnostics(responseBody)).toMatchObject({
          reason: 'provider_rejected',
          providerStatus: status,
          providerErrorCode: code,
          providerRequestId: 'req_synthetic-provider-id',
          attemptNumber: 1,
          gatewayRequestId: reply.headers['x-tro-request-id'],
        });
        expect(reply.body).not.toContain('private');
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
      const reply = await fixture.sendRequest();
      expect(reply.statusCode).toBe(502);
      const responseBody: unknown = reply.json();
      expect(readModelGatewayDiagnostics(responseBody)).toMatchObject({
        reason: 'provider_network_failed',
        networkCode: 'ECONNRESET',
        attemptNumber: 2,
        timedOut: false,
      });
      const finalRequestId = new Headers(provider.mock.calls[1]?.[1]?.headers).get(
        'x-client-request-id',
      );
      expect(readModelGatewayDiagnostics(responseBody)?.providerClientRequestId).toBe(
        finalRequestId,
      );
      expect(z.uuid().safeParse(finalRequestId).success).toBe(true);
      expect(reply.body).not.toContain('private');
      expect(provider).toHaveBeenCalledTimes(2);
      const logs = fixture.readLogs();
      expect(logs).toContain('Could not obtain a model response from OpenAI.');
      expect(logs).toContain('"networkCode":"ECONNRESET"');
      expect(logs).toContain('"reason":"provider_network_failed"');
      expect(logs).toContain('"event":"model.gateway.retry"');
      expect(logs.match(/"phase":"failed"/g)).toHaveLength(2);
      expect(logs).toContain('"requestBytes":');
      expect(logs).toContain('"transportObserved":false');
      expect(logs).toContain('model.gateway.attempt');
      expect(
        fixture
          .readEvents()
          .filter((entry) => entry.event === ModelGatewayEvent.ATTEMPT)
          .map((entry) => [entry.attemptNumber, entry.phase]),
      ).toEqual([
        [1, 'started'],
        [1, 'failed'],
        [2, 'started'],
        [2, 'failed'],
      ]);
      expect(logs).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('keeps supplied socket failure evidence API-only', async () => {
    const fixture = await createLoggingFixture();
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('private', {
        cause: {
          code: 'UND_ERR_SOCKET',
          message: 'other side closed',
          socket: { bytesWritten: 1234, bytesRead: 0, remoteAddress: 'private address' },
        },
      }),
    );
    try {
      const reply = await fixture.sendRequest();
      expect(reply.statusCode).toBe(502);
      expect(provider).toHaveBeenCalledTimes(2);
      const logs = fixture.readLogs();
      expect(logs).toContain('"socketFailureReason":"peer_closed"');
      expect(logs).toContain('"socketBytesWritten":1234');
      expect(logs).toContain('"socketBytesRead":0');
      expect(logs).not.toContain('private');
      expect(reply.body).not.toContain('"socketBytesWritten":');
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

  it('reports setup failure without emitting successful connection traces', async () => {
    const fixture = await createLoggingFixture();
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new TypeError('private host', { cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo' } }),
      );
    try {
      expect((await fixture.sendRequest()).statusCode).toBe(502);
      expect(provider).toHaveBeenCalledOnce();
      const logs = fixture.readLogs();
      expect(logs).toContain('model.gateway.failed');
      expect(logs).toContain('"networkCode":"ENOTFOUND"');
      expect(logs).not.toContain('model.gateway.connection.');
      expect(logs).toContain('model.gateway.attempt');
      expect(logs).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('preserves the original TLS cause in one safe failure event without retrying it', async () => {
    const fixture = await createLoggingFixture();
    const native = Object.assign(new Error('private peer:error:0A0003FC:SSL routines:private'), {
      code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
      library: 'SSL routines',
    });
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('private request', { cause: native }));
    try {
      const reply = await fixture.sendRequest();
      expect(reply.statusCode).toBe(502);
      expect(provider).toHaveBeenCalledOnce();
      const logs = fixture.readLogs();
      expect(logs.match(/"event":"model.gateway.failed"/g)).toHaveLength(1);
      expect(logs).toContain('"socketErrorCode":"ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC"');
      expect(logs).toContain('"socketTlsAlertNumber":20');
      expect(logs).toContain('"socketTlsErrorNumber":"0A0003FC"');
      expect(logs).not.toContain('model.gateway.connection.');
      expect(logs).toContain('model.gateway.attempt');
      expect(logs).not.toContain('private');
      expect(reply.body).not.toContain('socketTls');
    } finally {
      provider.mockRestore();
      await fixture.api.close();
    }
  });

  it('retains the observed TLS alert when fetch replaces it with a generic disconnect', async () => {
    const fixture = await createLoggingFixture();
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const request = {};
      const socket = new Socket();
      channel('undici:request:create').publish({ request });
      channel('undici:client:sendHeaders').publish({ request, socket });
      socket.emit(
        'error',
        Object.assign(new Error('private peer:error:0A0003FC:SSL routines:private'), {
          code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
          library: 'SSL routines',
        }),
      );
      socket.destroy();
      return Promise.reject(
        new TypeError('private request', { cause: { code: 'UND_ERR_SOCKET' } }),
      );
    });
    try {
      const reply = await fixture.sendRequest();
      expect(reply.statusCode).toBe(502);
      expect(provider).toHaveBeenCalledTimes(2);
      const failures = fixture
        .readEvents()
        .filter((event) => event.event === ModelGatewayEvent.FAILED);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        networkCode: 'UND_ERR_SOCKET',
        socketFailure: {
          socketErrorCode: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
          socketErrorReason: 'tls_bad_record_mac',
          socketTlsAlertNumber: 20,
          socketTlsErrorNumber: '0A0003FC',
        },
      });
      const attempts = fixture
        .readEvents()
        .filter((event) => event.event === ModelGatewayEvent.ATTEMPT && event.phase === 'failed');
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({ socketFailure: { socketTlsAlertNumber: 20 } });
      }
      expect(fixture.readLogs()).not.toContain('private');
      expect(reply.body).not.toContain('socketFailure');
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
      expect(fixture.readLogs()).not.toContain('model.gateway.first_byte');
      expect(fixture.readLogs()).toContain('model.gateway.attempt');
      expect(fixture.readLogs()).not.toContain('model.gateway.connection.');
      expect(fixture.readLogs()).toContain('"transportObserved":false');
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
      expect(
        fixture.readEvents().find((entry) => entry.event === ModelGatewayEvent.FAILED),
      ).toMatchObject({
        responseBytes: 0,
        responseChunks: 0,
        firstChunkAfterDispatchMs: null,
        lastChunkAfterDispatchMs: null,
        backpressureWaits: 0,
        backpressureDurationMs: 0,
      });
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
      registerModelGateway(api, readSignedInUserId, environment, api.log);

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
