import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  PracticeCommandSchema,
  PracticeReplySchema,
  PracticeFailure,
} from '#contracts/PracticeCheck.js';
import type { PracticeCheckService } from '../application/PracticeCheckService.js';
import { PracticeError } from '../domain/PracticeFindings.js';
export function registerPracticeCheckRoutes(
  api: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  service: PracticeCheckService,
  log: Pick<Logger, 'warn'>,
): void {
  api.post('/api/v1/classroom/practice', { bodyLimit: 3000000 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const userId = await readUserId(request.headers);
    if (!userId) {
      return reply.code(401).send({ kind: 'failed', code: PracticeFailure.FORBIDDEN });
    }
    const parsed = PracticeCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ kind: 'failed', code: PracticeFailure.INVALID });
    }
    try {
      return PracticeReplySchema.parse(await service.execute(userId, parsed.data));
    } catch (error: unknown) {
      const code = error instanceof PracticeError ? error.code : PracticeFailure.UNAVAILABLE;
      log.warn(
        { operation: parsed.data.kind, code, requestId: request.id },
        'classroom.practice.refused',
      );
      return reply
        .code(
          code === PracticeFailure.FORBIDDEN
            ? 403
            : code === PracticeFailure.STALE
              ? 409
              : code === PracticeFailure.INVALID
                ? 400
                : code === PracticeFailure.LIMIT
                  ? 429
                  : 503,
        )
        .send({ kind: 'failed', code });
    }
  });
}
