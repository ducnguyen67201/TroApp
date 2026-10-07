import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  ClassroomCommandSchema,
  ClassroomReplySchema,
  ClassroomFailure,
} from '#contracts/Classroom.js';
import { z } from 'zod';
import type { ClassroomService } from '../application/ClassroomService.js';
import { InvitationAttempts } from '../application/InvitationAttempts.js';
import { ClassroomError } from '../domain/ClassroomRules.js';

/** Authentication and runtime validation happen before any classroom workflow. */
export function registerClassroomRoutes(
  api: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  service: ClassroomService,
  log: Pick<Logger, 'warn' | 'error'>,
): void {
  const invitationAttempts = new InvitationAttempts();
  const closeStreams = new Set<() => void>();
  api.addHook('preClose', () => {
    for (const close of closeStreams) {
      close();
    }
  });
  api.get('/api/v1/classroom/updates', async (request, reply) => {
    const userId = await readUserId(request.headers);
    const parsed = z
      .strictObject({ participationId: z.uuid(), deviceId: z.uuid(), activityId: z.uuid() })
      .safeParse(request.query);
    if (!userId || !parsed.success) {
      return await reply.code(403).send({ kind: 'failed', code: ClassroomFailure.FORBIDDEN });
    }
    try {
      const result = await service.execute(userId, { kind: 'context', ...parsed.data });
      if (result.kind !== 'context') {
        return await reply.code(403).send({ kind: 'failed', code: ClassroomFailure.FORBIDDEN });
      }
      const classId = result.context.meeting.classId;
      let stopped = false;
      const unsubscribe = service.subscribe((changedClassId) => {
        if (changedClassId === classId && !stopped) {
          reply.raw.write('data: refresh\n\n');
        }
      });
      const heartbeat = setInterval(() => {
        if (!stopped) {
          reply.raw.write(': heartbeat\n\n');
        }
      }, 10_000);
      const close = (): void => {
        if (stopped) {
          return;
        }
        stopped = true;
        clearInterval(heartbeat);
        unsubscribe();
        closeStreams.delete(close);
        reply.raw.end();
      };
      closeStreams.add(close);
      reply.raw.once('close', close);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': connected\n\n');
      return await reply;
    } catch {
      return await reply.code(403).send({ kind: 'failed', code: ClassroomFailure.FORBIDDEN });
    }
  });
  api.post('/api/v1/classroom/command', { bodyLimit: 150_000 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const userId = await readUserId(request.headers);
    if (!userId) {
      return reply.code(401).send({ kind: 'failed', code: ClassroomFailure.UNAUTHORIZED });
    }
    const parsed = ClassroomCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ kind: 'failed', code: ClassroomFailure.INVALID });
    }
    if (
      parsed.data.kind === 'accept-invitation' &&
      !invitationAttempts.canAttempt(userId, Date.now())
    ) {
      return reply.code(429).send({ kind: 'failed', code: ClassroomFailure.UNAVAILABLE });
    }
    try {
      return ClassroomReplySchema.parse(await service.execute(userId, parsed.data));
    } catch (error: unknown) {
      const code = error instanceof ClassroomError ? error.code : ClassroomFailure.UNAVAILABLE;
      log.warn(
        { operation: parsed.data.kind, code, requestId: request.id },
        'classroom.command.refused',
      );
      if (!(error instanceof ClassroomError)) {
        log.error(
          {
            operation: parsed.data.kind,
            requestId: request.id,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          'classroom.command.failed',
        );
      }
      const status =
        code === ClassroomFailure.FORBIDDEN
          ? 403
          : code === ClassroomFailure.NOT_FOUND
            ? 404
            : code === ClassroomFailure.STALE
              ? 409
              : code === ClassroomFailure.INVALID
                ? 400
                : 503;
      return reply.code(status).send({ kind: 'failed', code });
    }
  });
}
