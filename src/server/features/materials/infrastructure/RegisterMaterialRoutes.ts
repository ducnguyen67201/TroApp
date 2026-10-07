import { MaterialFailure } from '#contracts/ClassroomMaterials.js';
import type { FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { Logger } from 'pino';
import {
  MaterialCommandSchema,
  MaterialReplySchema,
  MaterialLimits,
} from '#contracts/ClassroomMaterials.js';
import type { MaterialService } from '../application/MaterialService.js';
import { ClassroomError } from '../../classroom/domain/ClassroomRules.js';
import { ZodError } from 'zod';

export function registerMaterialRoutes(
  api: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  service: MaterialService,
  log: Pick<Logger, 'warn'>,
): void {
  api.post(
    '/api/v1/classroom/materials',
    {
      bodyLimit: Math.ceil(MaterialLimits.FILE_BYTES / 3) * 4 + 1_000_000,
      onRequest: async (request, reply) => {
        if (!(await readUserId(request.headers))) {
          await reply.code(401).send({ kind: 'failed', code: MaterialFailure.FORBIDDEN });
        }
      },
      errorHandler: (error, request, reply) => {
        const tooLarge = error.statusCode === 413;
        log.warn(
          {
            requestId: request.id,
            stage: 'read_material_request',
            code: tooLarge ? 'body_too_large' : 'invalid_request',
          },
          'classroom.materials.request.refused',
        );
        const status = error.statusCode ?? 500;
        const invalidInput = status >= 400 && status < 500;
        void reply.code(invalidInput ? status : 503).send({
          kind: 'failed',
          code: invalidInput ? MaterialFailure.INVALID : MaterialFailure.UNAVAILABLE,
        });
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const userId = await readUserId(request.headers);
      if (!userId) {
        return reply.code(401).send({ kind: 'failed', code: MaterialFailure.FORBIDDEN });
      }
      const parsed = MaterialCommandSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ kind: 'failed', code: MaterialFailure.INVALID });
      }
      try {
        return MaterialReplySchema.parse(await service.execute(userId, parsed.data));
      } catch (error: unknown) {
        const code =
          error instanceof ClassroomError &&
          (error.code === MaterialFailure.INVALID ||
            error.code === MaterialFailure.FORBIDDEN ||
            error.code === MaterialFailure.STALE)
            ? error.code
            : MaterialFailure.UNAVAILABLE;
        log.warn(
          {
            operation: parsed.data.kind,
            code,
            requestId: request.id,
            errorType:
              error instanceof ZodError
                ? 'invalid_stored_or_public_contract'
                : error instanceof ClassroomError
                  ? 'classroom_rule'
                  : 'unexpected_error',
            ...(error instanceof ZodError ? { validationIssueCount: error.issues.length } : {}),
          },
          'classroom.materials.refused',
        );
        return reply
          .code(
            code === MaterialFailure.STALE
              ? 409
              : code === MaterialFailure.FORBIDDEN
                ? 403
                : code === MaterialFailure.INVALID
                  ? 400
                  : 503,
          )
          .send({ kind: 'failed', code });
      }
    },
  );
}
