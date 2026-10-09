import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ModelTransportStage } from '#contracts/ModelTransportDiagnostics.js';
import { ModelTransportObserver } from '../../../src/server/auth/ModelTransportObserver.js';

async function createLocalProvider(
  reply: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(reply);
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

describe('request-scoped native model transport evidence', () => {
  it('preserves the result and reports no transport when the operation makes no request', async () => {
    const observer = new ModelTransportObserver();
    const result = { value: 7 };
    expect(await observer.observe(() => Promise.resolve(result))).toBe(result);
    expect(observer.readSocketFailure()).toBeUndefined();
    expect(observer.readSnapshot()).toMatchObject({
      transportObserved: false,
      lastTransportStage: null,
      socketAssigned: false,
      requestBodySent: false,
      providerHeadersReceived: false,
    });
  });

  it('records local upload and response stages without recording headers, URLs or body content', async () => {
    const fixture = await createLocalProvider((request, response) => {
      request.resume();
      request.once('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"result":"private response text"}');
      });
    });
    const observer = new ModelTransportObserver();
    const body = JSON.stringify({ input: 'private model input and screen fixture' });
    try {
      const response = await observer.observe(() =>
        fetch(fixture.url, {
          method: 'POST',
          headers: {
            authorization: 'Bearer private credential',
            'content-type': 'application/json',
          },
          body,
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
      const snapshot = observer.readSnapshot();
      expect(snapshot).toMatchObject({
        transportObserved: true,
        socketAssigned: true,
        requestBodySent: true,
        providerHeadersReceived: true,
        socketHadPriorTraffic: false,
        socketAddressFamily: 'IPv4',
        tlsAuthorized: null,
        tlsProtocol: null,
      });
      expect(snapshot.connectionId).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
      expect(snapshot.socketBytesWrittenSinceAssignment).toBeGreaterThan(Buffer.byteLength(body));
      expect(snapshot.socketBytesReadSinceAssignment).toBeGreaterThan(0);
      expect(snapshot.lastTransportStage).toBe(ModelTransportStage.RESPONSE_HEADERS);
      const events = snapshot.events ?? [];
      const requiredStages = [
        ModelTransportStage.REQUEST_CREATED,
        ModelTransportStage.SOCKET_ASSIGNED,
        ModelTransportStage.BODY_SENT,
        ModelTransportStage.RESPONSE_HEADERS,
      ];
      expect(events.map((event) => event.stage)).toEqual(expect.arrayContaining(requiredStages));
      const positions = requiredStages.map((stage) =>
        events.findIndex((event) => event.stage === stage),
      );
      expect(positions.every((position, index) => position > (positions[index - 1] ?? -1))).toBe(
        true,
      );
      expect(
        events.every(
          (event) => Number.isSafeInteger(event.afterStartMs) && event.afterStartMs >= 0,
        ),
      ).toBe(true);
      expect(
        events.every(
          (event, index) => event.afterStartMs >= (events[index - 1]?.afterStartMs ?? 0),
        ),
      ).toBe(true);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain('private');
      expect(serialized).not.toContain(fixture.url);
      expect(serialized).not.toContain('authorization');
      expect(serialized).not.toContain('127.0.0.1');
    } finally {
      await fixture.close();
    }
  });

  it('keeps concurrent fetches in their own observer scope', async () => {
    const fixture = await createLocalProvider((request, response) => {
      request.resume();
      request.once('end', () => response.end('{}'));
    });
    const firstObserver = new ModelTransportObserver();
    const secondObserver = new ModelTransportObserver();
    try {
      const responses = await Promise.all([
        firstObserver.observe(() => fetch(fixture.url, { method: 'POST', body: 'first fixture' })),
        secondObserver.observe(() =>
          fetch(fixture.url, { method: 'POST', body: 'second fixture' }),
        ),
      ]);
      await Promise.all(responses.map((response) => response.text()));
      const first = firstObserver.readSnapshot();
      const second = secondObserver.readSnapshot();
      expect(first).toMatchObject({
        socketAssigned: true,
        requestBodySent: true,
        providerHeadersReceived: true,
      });
      expect(second).toMatchObject({
        socketAssigned: true,
        requestBodySent: true,
        providerHeadersReceived: true,
      });
      expect(first.connectionId).toBeDefined();
      expect(second.connectionId).toBeDefined();
      expect(first.connectionId).not.toBe(second.connectionId);
    } finally {
      await fixture.close();
    }
  });

  it('ignores requests made outside the observed async operation', async () => {
    const fixture = await createLocalProvider((request, response) => {
      request.resume();
      request.once('end', () => response.end('{}'));
    });
    const observer = new ModelTransportObserver();
    let releaseOperation: (() => void) | undefined;
    const operation = observer.observe(
      () =>
        new Promise<void>((resolve) => {
          releaseOperation = resolve;
        }),
    );
    try {
      await (await fetch(fixture.url)).text();
      expect(observer.readSnapshot()).toMatchObject({
        transportObserved: false,
        socketAssigned: false,
        requestBodySent: false,
        providerHeadersReceived: false,
      });
    } finally {
      releaseOperation?.();
      await operation;
      await fixture.close();
    }
  });

  it('distinguishes a locally sent body from a missing provider response', async () => {
    const fixture = await createLocalProvider((request) => {
      request.resume();
      request.once('end', () => request.socket.destroy());
    });
    const observer = new ModelTransportObserver();
    try {
      await expect(
        observer.observe(() => fetch(fixture.url, { method: 'POST', body: 'fixture request' })),
      ).rejects.toThrow();
      expect(observer.readSnapshot()).toMatchObject({
        transportObserved: true,
        socketAssigned: true,
        requestBodySent: true,
        providerHeadersReceived: false,
      });
      expect([
        ModelTransportStage.REQUEST_FAILED,
        ModelTransportStage.SOCKET_ERROR,
        ModelTransportStage.SOCKET_CLOSED,
      ]).toContain(observer.readSnapshot().lastTransportStage);
    } finally {
      await fixture.close();
    }
  });

  it('preserves a native TLS alert when fetch rejects with a generic socket failure', async () => {
    const observer = new ModelTransportObserver();
    const socket = new Socket();
    const initialListenerCounts = {
      error: socket.listenerCount('error'),
      end: socket.listenerCount('end'),
      close: socket.listenerCount('close'),
    };
    const socketFailure = Object.assign(
      new Error('private:error:0A0003FC:SSL routines:private TLS identity', {
        cause: Object.assign(new Error('private nested cause'), { code: 'ECONNRESET' }),
      }),
      { code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC', library: 'SSL routines' },
    );
    const fetchFailure = new TypeError('private fetch wrapper', {
      cause: { code: 'UND_ERR_SOCKET' },
    });
    try {
      await expect(
        observer.observe(() => {
          observer.recordSocket(socket);
          socket.emit('error', socketFailure);
          socketFailure.code = 'EPIPE';
          socket.emit(
            'error',
            Object.assign(new Error('private later failure'), { code: 'EPIPE' }),
          );
          socket.emit('close', true);
          return Promise.reject(fetchFailure);
        }),
      ).rejects.toBe(fetchFailure);

      const snapshot = observer.readSnapshot();
      const retainedFailure = observer.readSocketFailure();
      expect(retainedFailure).toMatchObject({
        socketErrorCode: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
        socketErrorReason: 'tls_bad_record_mac',
        socketTlsErrorNumber: '0A0003FC',
        socketTlsReasonNumber: 1020,
        socketTlsAlertNumber: 20,
        socketErrorCauses: [{ causeDepth: 1, socketErrorCode: 'ECONNRESET' }],
      });
      expect(snapshot).toMatchObject({ socketErrorObserved: true, socketClosed: true });
      expect(socket.listenerCount('error')).toBe(initialListenerCounts.error);
      expect(socket.listenerCount('end')).toBe(initialListenerCounts.end);
      expect(socket.listenerCount('close')).toBe(initialListenerCounts.close);
      if (!retainedFailure) {
        throw new Error('The observer did not retain the native TLS failure.');
      }
      retainedFailure.socketErrorCode = 'EPIPE';
      const nestedCause = retainedFailure.socketErrorCauses[0];
      if (!nestedCause) {
        throw new Error('The observer did not retain the safe nested socket cause.');
      }
      nestedCause.socketErrorCode = 'EPIPE';
      expect(observer.readSocketFailure()).toMatchObject({
        socketErrorCode: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
        socketErrorCauses: [{ socketErrorCode: 'ECONNRESET' }],
      });
      socket.emit('end');
      socket.emit('close', false);
      observer.recordStage(ModelTransportStage.REQUEST_FAILED);
      expect(observer.readSnapshot()).toEqual(snapshot);
      expect(JSON.stringify(observer.readSocketFailure())).not.toContain('private');
    } finally {
      socket.destroy();
    }
  });

  it('bounds repeated diagnostic events while preserving the latest stage', async () => {
    const observer = new ModelTransportObserver();
    await observer.observe(() => {
      for (let index = 0; index < 40; index += 1) {
        observer.recordStage(ModelTransportStage.REQUEST_CREATED);
      }
      observer.recordStage(ModelTransportStage.REQUEST_FAILED);
      return Promise.resolve();
    });
    const snapshot = observer.readSnapshot();
    expect(snapshot.events).toHaveLength(16);
    expect(snapshot.eventsTruncated).toBe(true);
    expect(snapshot.lastTransportStage).toBe(ModelTransportStage.REQUEST_FAILED);
    expect(
      snapshot.events?.every((event) => event.stage === ModelTransportStage.REQUEST_CREATED),
    ).toBe(true);
  });

  it('freezes the snapshot at headers while later body traffic and socket closure remain outside the attempt', async () => {
    let finishResponse: (() => void) | undefined;
    const fixture = await createLocalProvider((request, response) => {
      request.resume();
      request.once('end', () => {
        finishResponse = () => {
          if (!response.writableEnded) {
            response.end('private body content '.repeat(4096));
          }
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.flushHeaders();
      });
    });
    const observer = new ModelTransportObserver();
    try {
      const response = await observer.observe(() =>
        fetch(fixture.url, { method: 'POST', body: 'private request' }),
      );
      const atHeaders = observer.readSnapshot();
      expect(atHeaders.lastTransportStage).toBe(ModelTransportStage.RESPONSE_HEADERS);
      if (!finishResponse) {
        throw new Error('The local provider did not prepare its body response.');
      }
      finishResponse();
      await response.text();
      observer.recordStage(ModelTransportStage.REQUEST_FAILED);
      expect(observer.readSnapshot()).toEqual(atHeaders);
    } finally {
      finishResponse?.();
      await fixture.close();
    }
  });

  it('preserves an operation failure when diagnostics become unavailable', async () => {
    const observer = new ModelTransportObserver();
    const originalFailure = new TypeError('private upstream cause');
    await expect(
      observer.observe(() => {
        observer.recordStage(ModelTransportStage.REQUEST_CREATED);
        observer.recordDiagnosticsUnavailable();
        return Promise.reject(originalFailure);
      }),
    ).rejects.toBe(originalFailure);
    expect(observer.readSnapshot()).toMatchObject({
      transportObserved: false,
      lastTransportStage: null,
      socketAssigned: false,
      providerHeadersReceived: false,
    });
    expect(JSON.stringify(observer.readSnapshot())).not.toContain('private');
  });
});
