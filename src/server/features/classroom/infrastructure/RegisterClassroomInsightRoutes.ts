import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  ClassroomInsightCommandSchema,
  ClassroomInsightReplySchema,
  InsightFailure,
} from '#contracts/ClassroomInsights.js';
import type { ClassroomInsightService } from '../application/ClassroomInsightService.js';
import { ClassroomInsightError } from '../domain/ClassroomInsightError.js';

/** Authenticate before parsing sources; return bounded refusal codes and never log work. */
export function registerClassroomInsightRoutes(
  api: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  service: Pick<ClassroomInsightService, 'execute'>,
  log: Pick<Logger, 'warn'>,
): void {
  api.post(
    '/api/v1/classroom/insights',
    {
      bodyLimit: 1000000,
      onRequest: async (_request, reply) => {
        reply.header('cache-control', 'no-store');
      },
      errorHandler: (error, request, reply) => {
        const code =
          error.statusCode === 413
            ? InsightFailure.LIMIT
            : error.statusCode === 400
              ? InsightFailure.INVALID
              : InsightFailure.UNAVAILABLE;
        log.warn(
          { operation: 'parse-request', code, requestId: request.id },
          'classroom.insights.refused',
        );
        reply
          .code(error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : 503)
          .send({ kind: 'failed', code });
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      let operation = 'authenticate';
      try {
        const userId = await readUserId(request.headers);
        if (!userId) {
          return await reply.code(401).send({ kind: 'failed', code: InsightFailure.FORBIDDEN });
        }
        operation = 'validate';
        const parsed = ClassroomInsightCommandSchema.safeParse(request.body);
        if (!parsed.success) {
          return await reply.code(400).send({ kind: 'failed', code: InsightFailure.INVALID });
        }
        operation = parsed.data.kind;
        return ClassroomInsightReplySchema.parse(await service.execute(userId, parsed.data));
      } catch (error: unknown) {
        const code =
          error instanceof ClassroomInsightError ? error.code : InsightFailure.UNAVAILABLE;
        log.warn({ operation, code, requestId: request.id }, 'classroom.insights.refused');
        const status =
          code === InsightFailure.FORBIDDEN
            ? 403
            : code === InsightFailure.STALE
              ? 409
              : code === InsightFailure.INVALID
                ? 400
                : code === InsightFailure.LIMIT
                  ? 429
                  : code === InsightFailure.REMOVED
                    ? 410
                    : 503;
        return reply.code(status).send({ kind: 'failed', code });
      }
    },
  );
}
