import type { ServerResponse } from 'node:http';
import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { ModelGatewayDiagnosticsSchema } from '#contracts/ModelGatewayError.js';
import { fetchModelResponse } from './FetchModelResponse.js';
import { ModelGatewayConfig } from './ModelGatewayConfig.js';
import { describeSocketClose } from './SocketCloseDiagnostics.js';
import type { ModelRequest } from './ModelRequest.js';
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
): Promise<void> {
  const context = { gatewayRequestId };
  const requestBody = JSON.stringify(modelRequest);
  const disconnect = new AbortController();
  const timeout = AbortSignal.timeout(ModelGatewayConfig.requestTimeoutMs);
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) {
      disconnect.abort();
    }
  });
  let upstream: Response;
  let attemptNumber = 0;
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
      },
    );
  } catch (error) {
    logger.error(
      {
        ...context,
        event: ModelGatewayEvent.FAILED,
        reason: disconnect.signal.aborted
          ? ModelGatewayFailure.CLIENT_DISCONNECTED
          : ModelGatewayFailure.NETWORK_FAILED,
        timedOut: timeout.aborted,
        ...describeNetworkFailure(error),
        ...describeOriginalSocketError(error),
        durationMs: Math.round(performance.now() - startedAt),
      },
      'Could not obtain a model response from OpenAI.',
    );
    sendModelFailure({
      ...context,
      reason: disconnect.signal.aborted
        ? ModelGatewayFailure.CLIENT_DISCONNECTED
        : ModelGatewayFailure.NETWORK_FAILED,
      attemptNumber,
      durationMs: Math.round(performance.now() - startedAt),
      timedOut: timeout.aborted,
      ...describeNetworkFailure(error),
    });
    return;
  }
  const providerContext = {
    ...context,
    providerStatus: upstream.status,
    providerRequestId: readProviderRequestId(upstream.headers),
  };
  if (!upstream.ok || !upstream.body) {
    const providerFailure = await readProviderFailure(upstream);
    logger.error(
      {
        ...providerContext,
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
  });
  const reader = upstream.body.getReader();
  let responseBytes = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done && !reply.raw.destroyed) {
      responseBytes += chunk.value.byteLength;
      if (!reply.raw.write(chunk.value)) {
        await waitForDrainOrClose(reply.raw);
      }
      chunk = await reader.read();
    }
    if (reply.raw.destroyed) {
      logger.info(
        {
          ...providerContext,
          event: ModelGatewayEvent.FAILED,
          reason: ModelGatewayFailure.CLIENT_DISCONNECTED,
          responseBytes,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'The desktop disconnected before the model response finished.',
      );
    } else {
      logger.info(
        {
          ...providerContext,
          event: ModelGatewayEvent.COMPLETED,
          responseBytes,
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
        responseBytes,
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
