import type { ServerResponse } from 'node:http';
import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import {
  ModelAbortSource,
  ModelGatewayDiagnosticsSchema,
  ModelRequestTraceHeader,
} from '#contracts/ModelGatewayError.js';
import { fetchModelResponse, ModelAttemptPhase } from './FetchModelResponse.js';
import { ModelGatewayConfig } from './ModelGatewayConfig.js';
import { describeSocketClose, type SocketCloseDiagnostics } from './SocketCloseDiagnostics.js';
import type { ModelRequest } from './ModelRequest.js';
import type { ModelTransportSnapshot } from '#contracts/ModelTransportDiagnostics.js';
import { describeModelFailureEvidence } from './ModelFailureEvidence.js';
import {
  ModelGatewayEvent,
  ModelGatewayFailure,
  describeNetworkFailure,
  readProviderFailure,
  readProviderRequestId,
} from './ModelGatewayDiagnostics.js';

/** Summarize the native cause for one failure event; successful sockets need no observers. */
function describeOriginalSocketError(error: unknown) {
  const summary = describeSocketClose(error);
  const original =
    [summary, ...summary.socketErrorCauses].find(
      (cause) => cause.socketErrorCodeState !== 'missing' || cause.socketTlsErrorNumber !== null,
    ) ?? summary;
  return {
    socketErrorCode: original.socketErrorCode,
    socketErrorCodeState: original.socketErrorCodeState,
    socketErrorReason: original.socketErrorReason,
    socketTlsErrorNumber: original.socketTlsErrorNumber,
    socketTlsReasonNumber: original.socketTlsReasonNumber,
    socketTlsAlertNumber: original.socketTlsAlertNumber,
  };
}

function waitForDrainOrClose(response: ServerResponse): Promise<void> {
  if (response.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    function finish(): void {
      response.off('drain', finish);
      response.off('close', finish);
      resolve();
    }

    response.once('drain', finish);
    response.once('close', finish);
  });
}

/** Forward one admitted request, retaining cancellation, backpressure and safe diagnostics. */
export async function forwardModelResponse(
  reply: FastifyReply,
  modelRequest: ModelRequest,
  providerKey: string,
  gatewayRequestId: string,
  startedAt: number,
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
  modelRequestId?: string,
): Promise<void> {
  const context = { gatewayRequestId, ...(modelRequestId ? { modelRequestId } : {}) };
  const requestBody = JSON.stringify(modelRequest);
  const requestBytes = Buffer.byteLength(requestBody);
  const disconnect = new AbortController();
  const timeout = AbortSignal.timeout(ModelGatewayConfig.requestTimeoutMs);
  let abortSource: (typeof ModelAbortSource)[keyof typeof ModelAbortSource] | null = null;
  const recordAbort = (source: (typeof ModelAbortSource)[keyof typeof ModelAbortSource]) => {
    if (abortSource !== null) {
      return;
    }
    abortSource = source;
    logger.warn(
      {
        ...context,
        event: ModelGatewayEvent.ABORTED,
        abortSource,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'Model gateway request was canceled.',
    );
  };
  const recordDeadline = () => {
    recordAbort(ModelAbortSource.DEADLINE);
  };
  const recordClientDisconnect = () => {
    recordAbort(ModelAbortSource.CLIENT);
  };
  timeout.addEventListener('abort', recordDeadline, { once: true });
  disconnect.signal.addEventListener('abort', recordClientDisconnect, { once: true });
  const stopAbortObservation = () => {
    timeout.removeEventListener('abort', recordDeadline);
    disconnect.signal.removeEventListener('abort', recordClientDisconnect);
  };
  reply.raw.once('finish', stopAbortObservation);
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) {
      disconnect.abort();
    }
    stopAbortObservation();
  });
  let upstream: Response;
  let attemptNumber = 0;
  let providerClientRequestId: string | undefined;
  let lastTransport: ModelTransportSnapshot | undefined;
  let lastSocketFailure: SocketCloseDiagnostics | undefined;
  const dispatchedAt = performance.now();
  logger.debug(
    {
      ...context,
      event: ModelGatewayEvent.DISPATCH,
      requestBytes,
      model: modelRequest.model,
      stream: modelRequest.stream,
    },
    'Model gateway is dispatching the provider request.',
  );
  const sendModelFailure = (details: unknown) => {
    const diagnostics = ModelGatewayDiagnosticsSchema.parse(details);
    reply.code(502).send({
      message: 'The model service could not complete the request.',
      diagnostics,
      error: {
        message: 'The model service could not complete the request.',
        type: 'api_error',
        code: 'tro_model_gateway_failed',
        diagnostics,
      },
    });
  };
  try {
    upstream = await fetchModelResponse(
      providerKey,
      requestBody,
      AbortSignal.any([disconnect.signal, timeout]),
      (error) => {
        logger.warn(
          {
            ...context,
            event: ModelGatewayEvent.RETRY,
            attemptNumber: ModelGatewayConfig.retry.maximumAttempts,
            retryDelayMs: ModelGatewayConfig.retry.delayMs,
            ...describeNetworkFailure(error),
            ...describeOriginalSocketError(error),
            durationMs: Math.round(performance.now() - startedAt),
          },
          'Retrying the model request after a temporary socket failure.',
        );
      },
      (attempt) => {
        attemptNumber = attempt.attemptNumber;
        providerClientRequestId = attempt.providerClientRequestId;
        lastTransport = attempt.transport;
        lastSocketFailure = attempt.socketFailure;
        logger[attempt.phase === ModelAttemptPhase.FAILED ? 'warn' : 'debug'](
          {
            ...context,
            event: ModelGatewayEvent.ATTEMPT,
            requestBytes,
            ...attempt,
            ...(attempt.phase === ModelAttemptPhase.FAILED
              ? describeModelFailureEvidence({
                  timedOut: timeout.aborted,
                  abortSource,
                  transport: attempt.transport,
                })
              : {}),
          },
          'Model gateway attempt transport evidence.',
        );
      },
    );
  } catch (error) {
    const reason = disconnect.signal.aborted
      ? ModelGatewayFailure.CLIENT_DISCONNECTED
      : ModelGatewayFailure.NETWORK_FAILED;
    const evidence = describeModelFailureEvidence({
      reason,
      timedOut: timeout.aborted,
      abortSource,
      transport: lastTransport,
    });
    logger.error(
      {
        ...context,
        event: ModelGatewayEvent.FAILED,
        reason,
        ...(providerClientRequestId ? { providerClientRequestId } : {}),
        ...evidence,
        abortSource,
        timedOut: timeout.aborted,
        ...(lastTransport ? { transport: lastTransport } : {}),
        ...describeNetworkFailure(error),
        ...describeOriginalSocketError(error),
        ...(lastSocketFailure ? { socketFailure: lastSocketFailure } : {}),
        durationMs: Math.round(performance.now() - startedAt),
      },
      'Could not obtain a model response from OpenAI.',
    );
    sendModelFailure({
      ...context,
      ...(providerClientRequestId ? { providerClientRequestId } : {}),
      reason,
      ...evidence,
      abortSource,
      attemptNumber,
      durationMs: Math.round(performance.now() - startedAt),
      timedOut: timeout.aborted,
      ...(lastTransport ? { transport: lastTransport } : {}),
      ...describeNetworkFailure(error),
    });
    return;
  }
  const providerContext = {
    ...context,
    ...(providerClientRequestId ? { providerClientRequestId } : {}),
    providerStatus: upstream.status,
    providerRequestId: readProviderRequestId(upstream.headers),
  };
  logger.debug(
    {
      ...providerContext,
      event: ModelGatewayEvent.PROVIDER_HEADERS,
      durationMs: Math.round(performance.now() - startedAt),
    },
    'Received provider response headers.',
  );
  if (!upstream.ok || !upstream.body) {
    const providerFailure = await readProviderFailure(upstream);
    logger.error(
      {
        ...providerContext,
        ...describeModelFailureEvidence({
          providerStatus: upstream.status,
          transport: lastTransport,
        }),
        event: ModelGatewayEvent.FAILED,
        reason: upstream.ok
          ? ModelGatewayFailure.BODY_MISSING
          : ModelGatewayFailure.PROVIDER_REJECTED,
        ...providerFailure,
        durationMs: Math.round(performance.now() - startedAt),
      },
      upstream.ok
        ? 'OpenAI returned an empty model response.'
        : 'OpenAI rejected the model request.',
    );
    sendModelFailure({
      ...providerContext,
      ...describeModelFailureEvidence({
        providerStatus: upstream.status,
        transport: lastTransport,
      }),
      reason: upstream.ok
        ? ModelGatewayFailure.BODY_MISSING
        : ModelGatewayFailure.PROVIDER_REJECTED,
      attemptNumber,
      durationMs: Math.round(performance.now() - startedAt),
      ...providerFailure,
    });
    return;
  }
  /* Preserve the Responses stream for the local SDK without logging model
   input, screenshots, tool output, or the provider response. */
  reply.hijack();
  reply.raw.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
    'x-tro-request-id': gatewayRequestId,
    ...(modelRequestId ? { [ModelRequestTraceHeader]: modelRequestId } : {}),
  });
  const reader = upstream.body.getReader();
  let responseBytes = 0;
  let responseChunks = 0;
  let firstChunkAt: number | null = null;
  let lastChunkAt: number | null = null;
  let backpressureWaits = 0;
  let backpressureDurationMs = 0;
  const readStreamMeasurements = () => ({
    responseBytes,
    responseChunks,
    firstChunkAfterDispatchMs:
      firstChunkAt === null ? null : Math.round(firstChunkAt - dispatchedAt),
    lastChunkAfterDispatchMs: lastChunkAt === null ? null : Math.round(lastChunkAt - dispatchedAt),
    backpressureWaits,
    backpressureDurationMs: Math.round(backpressureDurationMs),
  });
  try {
    let chunk = await reader.read();
    while (!chunk.done && !reply.raw.destroyed) {
      responseBytes += chunk.value.byteLength;
      responseChunks += 1;
      lastChunkAt = performance.now();
      if (firstChunkAt === null) {
        firstChunkAt = lastChunkAt;
        logger.debug(
          {
            ...providerContext,
            event: ModelGatewayEvent.FIRST_CHUNK,
            durationMs: Math.round(firstChunkAt - startedAt),
          },
          'Received the first provider response chunk.',
        );
      }
      if (!reply.raw.write(chunk.value)) {
        backpressureWaits += 1;
        const waitStartedAt = performance.now();
        await waitForDrainOrClose(reply.raw);
        backpressureDurationMs += performance.now() - waitStartedAt;
      }
      chunk = await reader.read();
    }
    if (reply.raw.destroyed) {
      logger.info(
        {
          ...providerContext,
          event: ModelGatewayEvent.FAILED,
          reason: ModelGatewayFailure.CLIENT_DISCONNECTED,
          abortSource,
          ...describeModelFailureEvidence({
            reason: ModelGatewayFailure.CLIENT_DISCONNECTED,
            abortSource,
            streamFailed: true,
            transport: lastTransport,
          }),
          ...readStreamMeasurements(),
          durationMs: Math.round(performance.now() - startedAt),
        },
        'The desktop disconnected before the model response finished.',
      );
    } else {
      logger.info(
        {
          ...providerContext,
          event: ModelGatewayEvent.COMPLETED,
          ...readStreamMeasurements(),
          durationMs: Math.round(performance.now() - startedAt),
        },
        'Finished forwarding the model response to the desktop.',
      );
    }
  } catch (error) {
    logger.warn(
      {
        ...providerContext,
        event: ModelGatewayEvent.FAILED,
        reason: disconnect.signal.aborted
          ? ModelGatewayFailure.CLIENT_DISCONNECTED
          : ModelGatewayFailure.STREAM_FAILED,
        timedOut: timeout.aborted,
        abortSource,
        ...describeModelFailureEvidence({
          timedOut: timeout.aborted,
          abortSource,
          providerStatus: upstream.status,
          streamFailed: true,
          transport: lastTransport,
        }),
        ...readStreamMeasurements(),
        ...describeNetworkFailure(error),
        ...describeOriginalSocketError(error),
        durationMs: Math.round(performance.now() - startedAt),
      },
      'Model response forwarding stopped before completion.',
    );
  } finally {
    reader.releaseLock();
  }
  if (!reply.raw.destroyed) {
    reply.raw.end();
  }
}
