import type { FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  GuidedLessonCommandSchema,
  GuidedLessonReadSchema,
  GuidedLessonReplySchema,
  GuidedLessonArtifactRequestSchema,
  GuidedLessonFailure,
  type GuidedLessonReply,
} from '#contracts/GuidedLessons.js';
import type { GuidedLessonService } from '../application/GuidedLessonService.js';
import { LessonError, LessonFailure } from '../application/LessonFailure.js';

function describeFailure(error: unknown): { status: number; reply: GuidedLessonReply } {
  const code =
    error instanceof LessonError
      ? error.code
      : error instanceof z.ZodError
        ? LessonFailure.INVALID
        : LessonFailure.UNAVAILABLE;
  if (code === LessonFailure.FORBIDDEN) {
    return {
      status: 403,
      reply: {
        kind: 'failed',
        code: GuidedLessonFailure.UNAUTHORIZED,
        message: 'This lesson is unavailable for this account.',
      },
    };
  }
  if (code === LessonFailure.STALE) {
    return {
      status: 409,
      reply: {
        kind: 'failed',
        code: GuidedLessonFailure.CONFLICT,
        message: 'The lesson changed. Refresh it before trying again.',
      },
    };
  }
  if (code === LessonFailure.BUDGET || code === LessonFailure.UNCERTAIN) {
    return {
      status: 409,
      reply: {
        kind: 'failed',
        code: GuidedLessonFailure.BUDGET_EXCEEDED,
        message:
          code === LessonFailure.UNCERTAIN
            ? 'An earlier provider request has uncertain usage and cannot be replayed.'
            : 'The lesson allowance is exhausted or cannot fit this request.',
      },
    };
  }
  return {
    status: code === LessonFailure.INVALID ? 400 : 503,
    reply: {
      kind: 'failed',
      code:
        code === LessonFailure.INVALID
          ? GuidedLessonFailure.INVALID_REQUEST
          : GuidedLessonFailure.UNAVAILABLE,
      message:
        code === LessonFailure.INVALID
          ? 'The lesson request or source selection is invalid.'
          : 'Guided lessons are temporarily unavailable.',
    },
  };
}

/** Protected JSON commands and bounded private binary reads share server-owned class/release authorization. */
export function registerGuidedLessonRoutes(
  api: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  service: GuidedLessonService,
  log: Pick<Logger, 'warn'>,
  wake: () => void = () => {},
): void {
  for (const action of ['read', 'command'] as const) {
    api.post(
      `/api/v1/guided-lessons/${action}`,
      { bodyLimit: 1024 * 1024 },
      async (request, reply) => {
        reply.header('cache-control', 'private, no-store');
        const userId = await readUserId(request.headers);
        if (!userId) {
          return reply.code(401).send({
            kind: 'failed',
            code: GuidedLessonFailure.UNAUTHORIZED,
            message: 'Sign in to use guided lessons.',
          });
        }
        try {
          const result =
            action === 'read'
              ? await service.read(userId, GuidedLessonReadSchema.parse(request.body))
              : await service.execute(userId, GuidedLessonCommandSchema.parse(request.body));
          if (action === 'command') {
            wake();
          }
          return GuidedLessonReplySchema.parse(result);
        } catch (error: unknown) {
          const failure = describeFailure(error);
          log.warn(
            {
              requestId: request.id,
              stage: action,
              code:
                failure.reply.kind === 'failed' ? failure.reply.code : GuidedLessonFailure.INTERNAL,
            },
            'guided-lessons.request.refused',
          );
          return reply.code(failure.status).send(failure.reply);
        }
      },
    );
  }
  api.get(
    '/api/v1/guided-lessons/:classId/:lessonId/artifacts/:artifactId',
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      const userId = await readUserId(request.headers);
      if (!userId) {
        return reply.code(401).send({
          kind: 'failed',
          code: GuidedLessonFailure.UNAUTHORIZED,
          message: 'Sign in to read lesson media.',
        });
      }
      try {
        const params = z
          .strictObject({ classId: z.uuid(), lessonId: z.uuid(), artifactId: z.uuid() })
          .parse(request.params);
        const query = z.strictObject({ releaseId: z.uuid().optional() }).parse(request.query);
        const artifact = await service.readArtifact(
          userId,
          GuidedLessonArtifactRequestSchema.parse({
            ...params,
            releaseId: query.releaseId ?? null,
          }),
        );
        reply.header('content-type', artifact.mimeType);
        reply.header('content-length', artifact.bytes.byteLength);
        reply.header('x-artifact-digest', artifact.digest);
        return await reply.send(Buffer.from(artifact.bytes));
      } catch (error: unknown) {
        const failure = describeFailure(error);
        log.warn(
          {
            requestId: request.id,
            stage: 'artifact',
            code:
              failure.reply.kind === 'failed' ? failure.reply.code : GuidedLessonFailure.INTERNAL,
          },
          'guided-lessons.artifact.refused',
        );
        return reply.code(failure.status).send(failure.reply);
      }
    },
  );
}
