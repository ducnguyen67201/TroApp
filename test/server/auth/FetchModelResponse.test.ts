import { createServer } from 'node:http';
import { Socket } from 'node:net';
import { channel } from 'node:diagnostics_channel';
import { describe, expect, it, vi } from 'vitest';
import {
  type ModelAttemptDiagnostics,
  fetchModelResponse,
} from '../../../src/server/auth/FetchModelResponse.js';
import { ModelGatewayConfig } from '../../../src/server/auth/ModelGatewayConfig.js';
import {
  ModelRequestTraceSchema,
  ProviderClientRequestHeader,
} from '#contracts/ModelGatewayError.js';

async function createClosingLocalProvider(failedRequests: number) {
  const connectionIds = new WeakMap<Socket, number>();
  const receivedRequests: { body: string; connectionId: number }[] = [];
  let connectionCount = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      }
    });
    request.once('end', () => {
      const connectionId = connectionIds.get(request.socket);
      if (connectionId === undefined) {
        response.writeHead(500);
        response.end();
        return;
      }
      receivedRequests.push({ body: Buffer.concat(chunks).toString('utf8'), connectionId });
      if (receivedRequests.length <= failedRequests) {
        request.socket.destroy();
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }
    });
  });
  server.on('connection', (socket) => {
    connectionCount += 1;
    connectionIds.set(socket, connectionCount);
  });
  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The fixture did not receive a TCP port.'));
        return;
      }
      resolve(`http://127.0.0.1:${String(address.port)}/responses`);
    });
  });
  return {
    url,
    receivedRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

describe('bounded model-only socket recovery', () => {
  it.each(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'])(
    'retries %s once with the same model request',
    async (code) => {
      const response = new Response('{}');
      const provider = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('private network detail', { cause: { code } }))
        .mockResolvedValueOnce(response);
      const reportRetry = vi.fn<(error: unknown) => void>().mockReturnValue(undefined);
      try {
        expect(
          await fetchModelResponse(
            'private-provider-key',
            'private-model-input',
            new AbortController().signal,
            reportRetry,
          ),
        ).toBe(response);
        expect(provider).toHaveBeenCalledTimes(2);
        const firstCall = provider.mock.calls[0];
        const secondCall = provider.mock.calls[1];
        expect(firstCall?.[0]).toBe(secondCall?.[0]);
        expect(firstCall?.[1]).toMatchObject({
          method: 'POST',
          body: 'private-model-input',
          headers: {
            authorization: 'Bearer private-provider-key',
            'content-type': 'application/json',
          },
        });
        expect(secondCall?.[1]).toMatchObject({
          method: 'POST',
          body: firstCall?.[1]?.body,
          signal: firstCall?.[1]?.signal,
          headers: {
            authorization: 'Bearer private-provider-key',
            'content-type': 'application/json',
          },
        });
        const firstRequestId = new Headers(firstCall?.[1]?.headers).get(
          ProviderClientRequestHeader,
        );
        const secondRequestId = new Headers(secondCall?.[1]?.headers).get(
          ProviderClientRequestHeader,
        );
        expect(ModelRequestTraceSchema.safeParse(firstRequestId).success).toBe(true);
        expect(ModelRequestTraceSchema.safeParse(secondRequestId).success).toBe(true);
        expect(secondRequestId).not.toBe(firstRequestId);
        expect(reportRetry).toHaveBeenCalledOnce();
      } finally {
        provider.mockRestore();
      }
    },
  );

  it('stops after one retry when the connection fails again', async () => {
    const failure = new TypeError('private', { cause: { code: 'UND_ERR_SOCKET' } });
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    const reportRetry = vi.fn<(error: unknown) => void>().mockReturnValue(undefined);
    try {
      await expect(
        fetchModelResponse('private-key', '{}', new AbortController().signal, reportRetry),
      ).rejects.toBe(failure);
      expect(provider).toHaveBeenCalledTimes(2);
      expect(reportRetry).toHaveBeenCalledOnce();
    } finally {
      provider.mockRestore();
    }
  });

  it.each(['ENOTFOUND', 'CERT_HAS_EXPIRED', 'ETIMEDOUT', 'UNKNOWN'])(
    'does not retry other network failures: %s',
    async (code) => {
      const failure = new TypeError('private', { cause: { code } });
      const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
      const reportRetry = vi.fn<(error: unknown) => void>();
      try {
        await expect(
          fetchModelResponse('private-key', '{}', new AbortController().signal, reportRetry),
        ).rejects.toBe(failure);
        expect(provider).toHaveBeenCalledOnce();
        expect(reportRetry).not.toHaveBeenCalled();
      } finally {
        provider.mockRestore();
      }
    },
  );

  it('cancels during the retry delay without reporting a retry or dispatching again', async () => {
    const cancellation = new AbortController();
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('private', { cause: { code: 'UND_ERR_SOCKET' } }));
    const reportRetry = vi.fn<(error: unknown) => void>();
    try {
      const attempt = fetchModelResponse('private-key', '{}', cancellation.signal, reportRetry);
      const rejection = expect(attempt).rejects.toThrow();
      await Promise.resolve();
      cancellation.abort();
      await rejection;
      expect(provider).toHaveBeenCalledOnce();
      expect(reportRetry).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });

  it('does not retry a provider response, even when its body later fails', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('private body'));
        },
      }),
    );
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const reportRetry = vi.fn<(error: unknown) => void>();
    try {
      expect(
        await fetchModelResponse('private-key', '{}', new AbortController().signal, reportRetry),
      ).toBe(response);
      await expect(response.text()).rejects.toThrow();
      expect(provider).toHaveBeenCalledOnce();
      expect(reportRetry).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });
});

it('reports every failed attempt separately and does not expose provider input', async () => {
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(
      new TypeError('private', { cause: { code: 'EPIPE', syscall: 'write', errno: -32 } }),
    );
  const attempts: ModelAttemptDiagnostics[] = [];
  try {
    await expect(
      fetchModelResponse(
        'private-key',
        'private-screen',
        new AbortController().signal,
        () => {},
        (attempt) => {
          attempts.push(attempt);
        },
      ),
    ).rejects.toThrow();
    expect(attempts.map((attempt) => [attempt.attemptNumber, attempt.phase])).toEqual([
      [1, 'started'],
      [1, 'failed'],
      [2, 'started'],
      [2, 'failed'],
    ]);
    expect(attempts[0]?.providerClientRequestId).toBe(attempts[1]?.providerClientRequestId);
    expect(attempts[2]?.providerClientRequestId).toBe(attempts[3]?.providerClientRequestId);
    expect(attempts[0]?.providerClientRequestId).not.toBe(attempts[2]?.providerClientRequestId);
    for (const attempt of attempts) {
      expect(ModelRequestTraceSchema.safeParse(attempt.providerClientRequestId).success).toBe(true);
    }
    expect(attempts[1]).toMatchObject({
      retryEligible: true,
      retryDelayMs: 250,
    });
    expect(attempts[3]).toMatchObject({
      retryEligible: false,
      retryDelayMs: 0,
      retryStopReason: 'attempts_exhausted',
    });
    expect(attempts[3]?.failure).toMatchObject({
      networkCode: 'EPIPE',
      networkSyscall: 'write',
      networkErrno: -32,
    });
    expect(JSON.stringify(attempts)).not.toContain('private');
  } finally {
    provider.mockRestore();
  }
});

it('reports the original native TLS alert separately from a generic fetch failure', async () => {
  const sockets: Socket[] = [];
  const failure = new TypeError('private fetch failure', { cause: { code: 'UND_ERR_SOCKET' } });
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const request = {};
    const socket = new Socket();
    sockets.push(socket);
    channel('undici:request:create').publish({ request });
    channel('undici:client:sendHeaders').publish({ request, socket });
    socket.emit(
      'error',
      Object.assign(new Error('private:error:0A0003FC:SSL routines:private TLS identity'), {
        code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
        library: 'SSL routines',
      }),
    );
    return Promise.reject(failure);
  });
  const attempts: ModelAttemptDiagnostics[] = [];
  try {
    await expect(
      fetchModelResponse(
        'private-key',
        'private-model-input',
        new AbortController().signal,
        () => {},
        (attempt) => attempts.push(attempt),
      ),
    ).rejects.toBe(failure);
    const failedAttempts = attempts.filter((attempt) => attempt.phase === 'failed');
    expect(failedAttempts).toHaveLength(2);
    for (const attempt of failedAttempts) {
      expect(attempt).toMatchObject({
        failure: { networkCode: 'UND_ERR_SOCKET' },
        socketFailure: {
          socketErrorCode: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
          socketErrorReason: 'tls_bad_record_mac',
          socketTlsAlertNumber: 20,
        },
      });
    }
    expect(
      attempts
        .filter((attempt) => attempt.phase === 'started')
        .every((attempt) => attempt.socketFailure === undefined),
    ).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(attempts)).not.toContain('private');
    for (const socket of sockets) {
      expect(socket.listenerCount('error')).toBe(0);
    }
  } finally {
    provider.mockRestore();
    for (const socket of sockets) {
      socket.destroy();
    }
  }
});

describe('real native-fetch socket recovery', () => {
  it('replays the same body on a different connection when the first peer closes before headers', async () => {
    const nativeFetch = globalThis.fetch;
    const fixture = await createClosingLocalProvider(1);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      expect(url).toBe(ModelGatewayConfig.providerResponsesUrl);
      return nativeFetch(fixture.url, options);
    });
    const attempts: ModelAttemptDiagnostics[] = [];
    const body = JSON.stringify({ input: 'private fixture input '.repeat(4096) });
    try {
      const response = await fetchModelResponse(
        'private-fixture-key',
        body,
        new AbortController().signal,
        () => {},
        (attempt) => attempts.push(attempt),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(provider).toHaveBeenCalledTimes(2);
      expect(fixture.receivedRequests.map((request) => request.body)).toEqual([body, body]);
      expect(fixture.receivedRequests[0]?.connectionId).not.toBe(
        fixture.receivedRequests[1]?.connectionId,
      );
      const failedAttempt = attempts.find((attempt) => attempt.phase === 'failed');
      const admittedRetry = attempts.find(
        (attempt) => attempt.attemptNumber === 2 && attempt.phase === 'headers_received',
      );
      expect(failedAttempt).toMatchObject({
        attemptNumber: 1,
        retryEligible: true,
        failure: { networkCode: 'UND_ERR_SOCKET', socketFailureReason: 'peer_closed' },
        transport: {
          transportObserved: true,
          socketAssigned: true,
          requestBodySent: true,
          providerHeadersReceived: false,
        },
      });
      expect(admittedRetry).toMatchObject({
        transport: {
          transportObserved: true,
          socketAssigned: true,
          requestBodySent: true,
          providerHeadersReceived: true,
        },
      });
      expect(failedAttempt?.transport?.connectionId).toBeDefined();
      expect(admittedRetry?.transport?.connectionId).toBeDefined();
      expect(failedAttempt?.transport?.connectionId).not.toBe(
        admittedRetry?.transport?.connectionId,
      );
      expect(JSON.stringify(attempts)).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.close();
    }
  });

  it('retains both failed attempts and stops when two real connections close before headers', async () => {
    const nativeFetch = globalThis.fetch;
    const fixture = await createClosingLocalProvider(2);
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      expect(url).toBe(ModelGatewayConfig.providerResponsesUrl);
      return nativeFetch(fixture.url, options);
    });
    const attempts: ModelAttemptDiagnostics[] = [];
    try {
      await expect(
        fetchModelResponse(
          'private-fixture-key',
          'private-fixture-body',
          new AbortController().signal,
          () => {},
          (attempt) => attempts.push(attempt),
        ),
      ).rejects.toThrow();
      const failedAttempts = attempts.filter((attempt) => attempt.phase === 'failed');
      expect(failedAttempts).toHaveLength(2);
      expect(failedAttempts[1]).toMatchObject({
        attemptNumber: 2,
        retryEligible: false,
        retryStopReason: 'attempts_exhausted',
        transport: { socketAssigned: true, providerHeadersReceived: false },
      });
      expect(failedAttempts[0]?.transport?.connectionId).toBeDefined();
      expect(failedAttempts[1]?.transport?.connectionId).toBeDefined();
      expect(failedAttempts[0]?.transport?.connectionId).not.toBe(
        failedAttempts[1]?.transport?.connectionId,
      );
      expect(provider).toHaveBeenCalledTimes(2);
      expect(fixture.receivedRequests.map((request) => request.body)).toEqual([
        'private-fixture-body',
        'private-fixture-body',
      ]);
      expect(JSON.stringify(attempts)).not.toContain('private');
    } finally {
      provider.mockRestore();
      await fixture.close();
    }
  });
});
