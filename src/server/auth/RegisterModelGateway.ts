import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { ServerEnv } from '../Env.js';
import type { createAuthDatabase } from '../persistence/AuthDatabase.js';

type Auth = ReturnType<typeof createAuthDatabase>['auth'];
type CountModelRequest = ReturnType<typeof createAuthDatabase>['countModelRequest'];

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
  auth: Auth,
  countModelRequest: CountModelRequest,
  environment: ServerEnv,
): void {
  const signingKey = createGatewayKey(environment.AUTH_SECRET);

  api.get('/api/v1/model/credential', async (request, reply) => {
    if (!environment.OPENAI_API_KEY) {
      return reply.code(503).send({ message: 'The model service is not configured.' });
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) {
      return reply.code(401).send({ message: 'Sign in to use the assistant.' });
    }

    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const token = await new SignJWT({ scope: 'model' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(session.user.id)
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
    if (!environment.OPENAI_API_KEY) {
      return reply.code(503).send({ message: 'The model service is not configured.' });
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ message: 'A model credential is required.' });
    }

    let userId: string;
    try {
      const verified = await jwtVerify(authorization.slice(7), signingKey, {
        issuer: 'tro-api',
        audience: 'tro-model',
      });
      if (verified.payload.scope !== 'model' || !verified.payload.sub) {
        return await reply.code(401).send({ message: 'The model credential is invalid.' });
      }
      userId = verified.payload.sub;
    } catch {
      return reply.code(401).send({ message: 'The model credential is invalid.' });
    }

    const parsed = ModelRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'The model request is invalid.' });
    }

    /* Atomically count attempts before contacting the paid provider. This is a
       first product limit; entitlement plans can replace the fixed allowance. */
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const requestCount = await countModelRequest(userId, day);
    if (requestCount > 100) {
      return reply.code(429).send({ message: 'Daily model allowance reached.' });
    }

    const modelRequest = {
      ...parsed.data,
      max_output_tokens: Math.min(parsed.data.max_output_tokens ?? 4096, 4096),
    };
    const disconnect = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) disconnect.abort();
    });
    let upstream: Response;
    try {
      upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${environment.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(modelRequest),
        signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(120_000)]),
      });
    } catch {
      return reply.code(502).send({ message: 'The model service could not complete the request.' });
    }
    if (!upstream.ok || !upstream.body) {
      return reply.code(502).send({ message: 'The model service could not complete the request.' });
    }

    /* Preserve the Responses stream for the local SDK without logging model
       input, screenshots, tool output, or the provider response. */
    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    });
    const reader = upstream.body.getReader();
    try {
      let chunk = await reader.read();
      while (!chunk.done && !reply.raw.destroyed) {
        if (!reply.raw.write(chunk.value)) await waitForDrainOrClose(reply.raw);
        chunk = await reader.read();
      }
    } catch {
      /* The client may have canceled during a model stream. */
    }
    if (!reply.raw.destroyed) reply.raw.end();
  });
}
