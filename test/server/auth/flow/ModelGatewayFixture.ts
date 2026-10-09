import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import pino from 'pino';
import { z } from 'zod';
import { ModelCredentialSchema } from '#contracts/AuthSession.js';
import {
  ModelFailureEvidenceSchema,
  ModelRequestTraceHeader,
  ModelRequestTraceSchema,
} from '#contracts/ModelGatewayError.js';
import { ModelTransportSnapshotSchema } from '#contracts/ModelTransportDiagnostics.js';
import { readServerEnv } from '../../../../src/server/Env.js';
import { ModelGatewayConfig } from '../../../../src/server/auth/ModelGatewayConfig.js';
import { registerModelGateway } from '../../../../src/server/auth/RegisterModelGateway.js';

export const ModelGatewayFixtureMode = {
  SUCCESS: 'success',
  CLOSE_DURING_UPLOAD: 'close_during_upload',
  CLOSE_BEFORE_HEADERS: 'close_before_headers',
  MALFORMED_HEADERS: 'malformed_headers',
  PROVIDER_REJECTION: 'provider_rejection',
  TRUNCATE_RESPONSE: 'truncate_response',
  HOLD_HEADERS: 'hold_headers',
  INVALID_TLS_PEER: 'invalid_tls_peer',
} as const;

export type ModelGatewayFixtureMode =
  (typeof ModelGatewayFixtureMode)[keyof typeof ModelGatewayFixtureMode];

const safeNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeName = z.string().max(160);

/** Keep only owned diagnostic fields; never persist Pino hostnames, messages or content. */
const GatewayLogSchema = z.object({
  event: safeName,
  gatewayRequestId: safeName.optional(),
  modelRequestId: z.uuid().nullable().optional(),
  providerClientRequestId: ModelRequestTraceSchema.optional(),
  attemptNumber: safeNumber.optional(),
  phase: safeName.optional(),
  stage: safeName.optional(),
  reason: safeName.optional(),
  durationMs: safeNumber.optional(),
  requestBytes: safeNumber.optional(),
  responseBytes: safeNumber.optional(),
  responseChunks: safeNumber.optional(),
  firstChunkAfterDispatchMs: safeNumber.nullable().optional(),
  lastChunkAfterDispatchMs: safeNumber.nullable().optional(),
  backpressureWaits: safeNumber.optional(),
  backpressureDurationMs: safeNumber.optional(),
  responseDestroyed: z.boolean().optional(),
  responseFinished: z.boolean().optional(),
  status: safeNumber.optional(),
  providerStatus: safeNumber.optional(),
  providerRequestId: safeName.nullable().optional(),
  providerErrorCode: safeName.nullable().optional(),
  providerErrorType: safeName.nullable().optional(),
  networkCode: safeName.nullable().optional(),
  networkSyscall: safeName.nullable().optional(),
  timedOut: z.boolean().optional(),
  aborted: z.boolean().optional(),
  abortSource: safeName.nullable().optional(),
  retryEligible: z.boolean().optional(),
  retryDelayMs: safeNumber.optional(),
  retryStopReason: safeName.optional(),
  failureCategory: safeName.optional(),
  failureStage: ModelFailureEvidenceSchema.shape.failureStage.optional(),
  connectionUse: ModelFailureEvidenceSchema.shape.connectionUse.optional(),
  socketErrorCode: safeName.nullable().optional(),
  socketTlsErrorNumber: safeName.nullable().optional(),
  socketTlsAlertNumber: safeNumber.nullable().optional(),
  socketBytesWritten: safeNumber.nullable().optional(),
  socketBytesRead: safeNumber.nullable().optional(),
  transport: ModelTransportSnapshotSchema.optional(),
  failure: z.object({ networkCode: safeName.nullable().optional() }).optional(),
});

export type ModelGatewayFixtureLog = z.infer<typeof GatewayLogSchema>;

export interface ModelGatewayProviderEvidence {
  event: 'fixture.provider.request';
  connectionId: number;
  requestNumber: number;
  requestBytesReceived: number;
  expectedRequestBytes: number | null;
  requestBodyComplete: boolean;
  providerClientRequestId: string | null;
  behavior: ModelGatewayFixtureMode;
}

export interface ModelGatewayFixture {
  gatewayUrl: string;
  providerUrl: string;
  token: string;
  logs: ModelGatewayFixtureLog[];
  providerEvidence: ModelGatewayProviderEvidence[];
  sendRequest: (inputCharacters?: number, signal?: AbortSignal) => Promise<Response>;
  waitForProviderRequest: () => Promise<void>;
  hasSafeLogs: () => boolean;
  close: () => Promise<void>;
}

/** Real sockets and authenticated routes, with synthetic content and loopback transport only.
 * The temporary fetch remap is restored on close. Run these fixtures sequentially. */
export async function createModelGatewayFixture(
  mode: ModelGatewayFixtureMode,
  report: (event: ModelGatewayFixtureLog | ModelGatewayProviderEvidence) => void,
): Promise<ModelGatewayFixture> {
  const logs: ModelGatewayFixtureLog[] = [];
  const providerEvidence: ModelGatewayProviderEvidence[] = [];
  const nativeFetch = globalThis.fetch;
  const connections = new WeakMap<Socket, number>();
  let connectionCount = 0;
  let requestCount = 0;
  let resolveFirstRequest: (() => void) | undefined;
  const firstRequest = new Promise<void>((resolve) => {
    resolveFirstRequest = resolve;
  });
  const timers = new Set<NodeJS.Timeout>();

  function recordProviderRequest(
    request: IncomingMessage,
    requestNumber: number,
    requestBytesReceived: number,
    requestBodyComplete: boolean,
  ): void {
    const contentLength = Number(request.headers['content-length']);
    const providerTrace = ModelRequestTraceSchema.safeParse(request.headers['x-client-request-id']);
    const evidence: ModelGatewayProviderEvidence = {
      event: 'fixture.provider.request',
      connectionId: connections.get(request.socket) ?? 0,
      requestNumber,
      requestBytesReceived,
      expectedRequestBytes:
        Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null,
      requestBodyComplete,
      providerClientRequestId: providerTrace.success ? providerTrace.data : null,
      behavior: mode,
    };
    providerEvidence.push(evidence);
    report(evidence);
  }

  function sendProviderResponse(request: IncomingMessage, response: ServerResponse): void {
    switch (mode) {
      case ModelGatewayFixtureMode.CLOSE_BEFORE_HEADERS:
        request.socket.destroy();
        return;
      case ModelGatewayFixtureMode.MALFORMED_HEADERS:
        request.socket.end('INVALID HTTP RESPONSE\r\n\r\n');
        return;
      case ModelGatewayFixtureMode.PROVIDER_REJECTION:
        response.writeHead(400, {
          'content-type': 'application/json',
          'x-request-id': 'req_fixture-rejection',
        });
        response.end(
          JSON.stringify({ error: { code: 'invalid_value', type: 'invalid_request_error' } }),
        );
        return;
      case ModelGatewayFixtureMode.TRUNCATE_RESPONSE: {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-length': '256',
          'x-request-id': 'req_fixture-truncated',
        });
        response.write('data: {}\n\n');
        response.flushHeaders();
        const timer = setTimeout(() => {
          timers.delete(timer);
          request.socket.destroy();
        }, 20);
        timers.add(timer);
        return;
      }
      case ModelGatewayFixtureMode.HOLD_HEADERS:
      case ModelGatewayFixtureMode.CLOSE_DURING_UPLOAD:
      case ModelGatewayFixtureMode.INVALID_TLS_PEER:
        return;
      case ModelGatewayFixtureMode.SUCCESS:
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-request-id': 'req_fixture-success',
        });
        response.end('{"id":"synthetic-response"}');
    }
  }

  const provider = createServer((request, response) => {
    requestCount += 1;
    const requestNumber = requestCount;
    let requestBytesReceived = 0;
    let recorded = false;
    resolveFirstRequest?.();
    request.on('data', (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) {
        return;
      }
      requestBytesReceived += chunk.byteLength;
      if (mode === ModelGatewayFixtureMode.CLOSE_DURING_UPLOAD && !recorded) {
        recorded = true;
        recordProviderRequest(request, requestNumber, requestBytesReceived, false);
        request.pause();
        request.socket.destroy();
      }
    });
    request.once('end', () => {
      if (!recorded) {
        recorded = true;
        recordProviderRequest(request, requestNumber, requestBytesReceived, true);
      }
      sendProviderResponse(request, response);
    });
    request.once('error', () => {
      if (!recorded) {
        recorded = true;
        recordProviderRequest(request, requestNumber, requestBytesReceived, false);
      }
    });
  });
  provider.on('connection', (socket) => {
    connectionCount += 1;
    connections.set(socket, connectionCount);
    socket.on('error', () => {
      // Deliberate fixture peer failures are measured by the client observer.
    });
  });
  provider.on('clientError', (_error, socket) => {
    /* An HTTPS client talks to this HTTP peer only in the explicit TLS failure case. */
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  });
  const providerUrl = await new Promise<string>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', () => {
      const address = provider.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The local provider did not receive a TCP port.'));
        return;
      }
      const protocol = mode === ModelGatewayFixtureMode.INVALID_TLS_PEER ? 'https' : 'http';
      resolve(`${protocol}://127.0.0.1:${String(address.port)}/responses`);
    });
  });
  const output = new PassThrough();
  let bufferedLog = '';
  let rawLog = '';
  let logLimitExceeded = false;
  output.on('data', (chunk: unknown) => {
    if (!Buffer.isBuffer(chunk)) {
      return;
    }
    const contents = chunk.toString('utf8');
    if (rawLog.length + contents.length > 256 * 1024) {
      logLimitExceeded = true;
    } else {
      rawLog += contents;
    }
    bufferedLog += contents;
    const lines = bufferedLog.split('\n');
    bufferedLog = lines.pop() ?? '';
    for (const line of lines) {
      const value: unknown = JSON.parse(line);
      const parsed = GatewayLogSchema.safeParse(value);
      if (parsed.success) {
        logs.push(parsed.data);
        report(parsed.data);
      }
    }
  });
  const api = Fastify();
  registerModelGateway(
    api,
    () => Promise.resolve('synthetic-user'),
    readServerEnv({
      APP_ENV: 'dev',
      DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
      AUTH_SECRET: 'synthetic-local-gateway-secret-at-least-32-characters',
      OPENAI_API_KEY: 'synthetic-local-provider-key-0000',
    }),
    pino({ level: 'debug' }, output),
  );
  const gatewayUrl = await api.listen({ host: '127.0.0.1', port: 0 });
  const credential = await nativeFetch(gatewayUrl + '/api/v1/model/credential');
  const credentialBody: unknown = await credential.json();
  const token = ModelCredentialSchema.parse(credentialBody).token;
  globalThis.fetch = (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === ModelGatewayConfig.providerResponsesUrl) {
      return nativeFetch(providerUrl, options);
    }
    if (!url.startsWith(gatewayUrl + '/') && !url.startsWith(providerUrl)) {
      return Promise.reject(new Error('The diagnostic fixture forbids external requests.'));
    }
    return nativeFetch(input, options);
  };

  return {
    gatewayUrl,
    providerUrl,
    token,
    logs,
    providerEvidence,
    sendRequest: (inputCharacters = 1024, signal) =>
      fetch(gatewayUrl + '/api/v1/model/responses', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          [ModelRequestTraceHeader]: randomUUID(),
        },
        body: JSON.stringify({
          model: ModelGatewayConfig.model,
          input: 'synthetic fixture content '.repeat(Math.ceil(inputCharacters / 26)),
          stream: false,
        }),
        signal: signal ?? AbortSignal.timeout(5000),
      }),
    waitForProviderRequest: () => firstRequest,
    hasSafeLogs: () =>
      !logLimitExceeded &&
      [
        token,
        providerUrl,
        'synthetic fixture content',
        'synthetic-local-provider-key-0000',
        'synthetic-local-gateway-secret-at-least-32-characters',
      ].every((privateValue) => !rawLog.includes(privateValue)),
    close: async () => {
      globalThis.fetch = nativeFetch;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      provider.closeAllConnections();
      await api.close();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      output.destroy();
    },
  };
}
