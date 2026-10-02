import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { ServerEnv } from '../Env.js';
import type { createAuthDatabase } from '../persistence/AuthDatabase.js';
import { fetchModelResponse, ModelGatewayRetry } from './FetchModelResponse.js';
import {
  ModelGatewayEvent,
  ModelGatewayFailure,
  describeNetworkFailure,
  readProviderFailure,
  readProviderRequestId,
} from './ModelGatewayDiagnostics.js';

type ReadSignedInUserId = ReturnType<typeof createAuthDatabase>['readSignedInUserId'];

const ModelRequestSchema = z.looseObject({
  model: z.literal('gpt-5.4'),
  input: z.unknown(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

function createGatewayKey(secret: string): Uint8Array {
  return createHash('sha256').update('tro-model-gateway-v1:').update(secret).digest();
}

function waitForDrainOrClose(response: ServerResponse): Promise<void> {
  if (response.destroyed) return Promise.resolve();
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

/** Exchanges a Tro login for a short-lived model-only credential. */
export function registerModelGateway(
  api: FastifyInstance,
  readSignedInUserId: ReadSignedInUserId,
  environment: ServerEnv,
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> = api.log,
): void {
  const signingKey = createGatewayKey(environment.AUTH_SECRET);

  api.get('/api/v1/model/credential', async (request, reply) => {
    if (!environment.OPENAI_API_KEY) {
      return reply.code(503).send({ message: 'The model service is not configured.' });
    }
    const userId = await readSignedInUserId(request.headers);
    if (!userId) {
      return reply.code(401).send({ message: 'Sign in to use the assistant.' });
    }

    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const token = await new SignJWT({ scope: 'model' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('tro-api')
      .setAudience('tro-model')
      .setExpirationTime(expiresAt)
      .sign(signingKey);

    return reply.header('cache-control', 'no-store').send({
      token,
      expiresAt: expiresAt.toISOString(),
    });
  });

  api.post('/api/v1/model/responses', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const startedAt = performance.now();
    const context = { gatewayRequestId: request.id };
    reply.header('x-tro-request-id', request.id);
    logger.debug(
      { ...context, event: ModelGatewayEvent.REQUEST },
      'Received an assistant model request.',
    );
    const rejectRequest = (
      status: number,
      reason: (typeof ModelGatewayFailure)[keyof typeof ModelGatewayFailure],
      message: string,
    ) => {
      logger.warn(
        {
          ...context,
          event: ModelGatewayEvent.REJECTED,
          status,
          reason,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'Model gateway rejected the request before contacting OpenAI.',
      );
      return reply.code(status).send({ message });
    };
    if (!environment.OPENAI_API_KEY) {
      return rejectRequest(
        503,
        ModelGatewayFailure.PROVIDER_NOT_CONFIGURED,
        'The model service is not configured.',
      );
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return rejectRequest(
        401,
        ModelGatewayFailure.CREDENTIAL_REQUIRED,
        'A model credential is required.',
      );
    }

    try {
      const verified = await jwtVerify(authorization.slice(7), signingKey, {
        issuer: 'tro-api',
        audience: 'tro-model',
      });
      if (verified.payload.scope !== 'model' || !verified.payload.sub) {
        return await rejectRequest(
          401,
          ModelGatewayFailure.CREDENTIAL_INVALID,
          'The model credential is invalid.',
        );
      }
    } catch {
      return rejectRequest(
        401,
        ModelGatewayFailure.CREDENTIAL_INVALID,
        'The model credential is invalid.',
      );
    }

    const parsed = ModelRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return rejectRequest(
        400,
        ModelGatewayFailure.REQUEST_INVALID,
        'The model request is invalid.',
      );
    }

    const modelRequest = {
      ...parsed.data,
      max_output_tokens: Math.min(parsed.data.max_output_tokens ?? 4096, 4096),
    };
    const requestBody = JSON.stringify(modelRequest);
    const disconnect = new AbortController();
    const timeout = AbortSignal.timeout(120_000);
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) disconnect.abort();
    });
    let upstream: Response;
    logger.debug(
      {
        ...context,
        event: ModelGatewayEvent.DISPATCH,
        model: modelRequest.model,
        stream: modelRequest.stream ?? false,
        requestBytes: Buffer.byteLength(requestBody),
        maxOutputTokens: modelRequest.max_output_tokens,
      },
      'Sending the model request to OpenAI.',
    );
    try {
      upstream = await fetchModelResponse(
        environment.OPENAI_API_KEY,
        requestBody,
        AbortSignal.any([disconnect.signal, timeout]),
        (error) => {
          logger.warn(
            {
              ...context,
              event: ModelGatewayEvent.RETRY,
              attemptNumber: ModelGatewayRetry.MAXIMUM_ATTEMPTS,
              retryDelayMs: ModelGatewayRetry.DELAY_MS,
              ...describeNetworkFailure(error),
              durationMs: Math.round(performance.now() - startedAt),
            },
            'Retrying the model request after a temporary socket failure.',
          );
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
          durationMs: Math.round(performance.now() - startedAt),
        },
        'Could not obtain a model response from OpenAI.',
      );
      return reply.code(502).send({ message: 'The model service could not complete the request.' });
    }
    const providerContext = {
      ...context,
      providerStatus: upstream.status,
      providerRequestId: readProviderRequestId(upstream.headers),
    };
    if (!upstream.ok || !upstream.body) {
      logger.error(
        {
          ...providerContext,
          event: ModelGatewayEvent.FAILED,
          reason: upstream.ok
            ? ModelGatewayFailure.BODY_MISSING
            : ModelGatewayFailure.PROVIDER_REJECTED,
          ...(await readProviderFailure(upstream)),
          durationMs: Math.round(performance.now() - startedAt),
        },
        upstream.ok
          ? 'OpenAI returned an empty model response.'
          : 'OpenAI rejected the model request.',
      );
      return reply.code(502).send({ message: 'The model service could not complete the request.' });
    }
    logger.debug(
      {
        ...providerContext,
        event: ModelGatewayEvent.RESPONSE,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'OpenAI accepted the model request; forwarding its response.',
    );

    /* Preserve the Responses stream for the local SDK without logging model
       input, screenshots, tool output, or the provider response. */
    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
      'x-tro-request-id': request.id,
    });
    const reader = upstream.body.getReader();
    let responseBytes = 0;
    try {
      let chunk = await reader.read();
      while (!chunk.done && !reply.raw.destroyed) {
        responseBytes += chunk.value.byteLength;
        if (!reply.raw.write(chunk.value)) await waitForDrainOrClose(reply.raw);
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
          durationMs: Math.round(performance.now() - startedAt),
        },
        'Model response forwarding stopped before completion.',
      );
    } finally {
      reader.releaseLock();
    }
    if (!reply.raw.destroyed) reply.raw.end();
  });
}
