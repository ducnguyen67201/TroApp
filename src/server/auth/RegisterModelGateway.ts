import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ServerEnv } from '../Env.js';
import type { createAuthDatabase } from '../persistence/AuthDatabase.js';
import { createModelCredentials } from './ModelCredentials.js';
import { ModelGatewayConfig } from './ModelGatewayConfig.js';
import { ModelRequestSchema, limitModelOutputTokens } from './ModelRequest.js';
import { forwardModelResponse } from './ForwardModelResponse.js';
import { ModelGatewayEvent, ModelGatewayFailure } from './ModelGatewayDiagnostics.js';

type ReadSignedInUserId = ReturnType<typeof createAuthDatabase>['readSignedInUserId'];

/** Register authentication and admission; provider transport owns forwarding and streaming. */
export function registerModelGateway(
  api: FastifyInstance,
  readSignedInUserId: ReadSignedInUserId,
  environment: ServerEnv,
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> = api.log,
): void {
  const credentials = createModelCredentials(environment.AUTH_SECRET);

  api.get('/api/v1/model/credential', async (request, reply) => {
    if (!environment.OPENAI_API_KEY) {
      return reply.code(503).send({ message: 'The model service is not configured.' });
    }
    const userId = await readSignedInUserId(request.headers);
    if (!userId) {
      return reply.code(401).send({ message: 'Sign in to use the assistant.' });
    }
    const credential = await credentials.issueModelCredential(userId);
    return reply.header('cache-control', 'no-store').send(credential);
  });

  api.post(
    '/api/v1/model/responses',
    { bodyLimit: ModelGatewayConfig.bodyLimitBytes },
    async (request, reply) => {
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
      const providerKey = environment.OPENAI_API_KEY;
      if (!providerKey) {
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
      if (!(await credentials.isModelCredentialValid(authorization.slice(7)))) {
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
      await forwardModelResponse(
        reply,
        limitModelOutputTokens(parsed.data),
        providerKey,
        request.id,
        startedAt,
        logger,
      );
      return reply;
    },
  );
}
