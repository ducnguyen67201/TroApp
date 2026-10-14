import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ClassroomCommandSchema, ClassroomFailure } from '#contracts/Classroom.js';
import { MaterialCommandSchema } from '#contracts/ClassroomMaterials.js';
import { PracticeCommandSchema } from '#contracts/PracticeCheck.js';
import { ClassroomInsightCommandSchema } from '#contracts/ClassroomInsights.js';
import { ClassroomPersonIdSchema, ClassroomViewAs } from '#contracts/ClassroomViewAs.js';
import type { ClassroomStore } from '../application/ClassroomStore.js';

const classroomPaths = new Set([
  '/api/v1/classroom/command',
  '/api/v1/classroom/updates',
  '/api/v1/classroom/materials',
  '/api/v1/classroom/practice',
  '/api/v1/classroom/insights',
]);

/** Delegation is confined to classroom routes; authentication and all other APIs keep the actor. */
export function registerClassroomViewAs(
  api: FastifyInstance,
  readSignedInUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  store: Pick<ClassroomStore, 'readIsAdmin' | 'readClassroomPerson'>,
  log: Pick<Logger, 'info' | 'warn'>,
): (headers: IncomingHttpHeaders) => Promise<string | null> {
  const identities = new WeakMap<IncomingHttpHeaders, { actorId: string; userId: string }>();
  api.addHook('onRequest', async (request, reply) => {
    const requested = request.headers[ClassroomViewAs.HEADER];
    if (requested === undefined) {
      return;
    }
    const personId = ClassroomPersonIdSchema.safeParse(requested);
    const actorId = await readSignedInUserId(request.headers);
    if (
      !classroomPaths.has(request.routeOptions.url ?? '') ||
      !personId.success ||
      !actorId ||
      !(await store.readIsAdmin(actorId)) ||
      !(await store.readClassroomPerson(personId.data))
    ) {
      log.warn({ requestId: request.id, actorId }, 'classroom.view_as.refused');
      await reply.code(403).send({ kind: 'failed', code: ClassroomFailure.FORBIDDEN });
      return;
    }
    identities.set(request.headers, { actorId, userId: personId.data });
  });
  api.addHook('preHandler', async (request, reply) => {
    if (
      !identities.has(request.headers) ||
      request.routeOptions.url !== '/api/v1/classroom/command'
    ) {
      return;
    }
    const command = ClassroomCommandSchema.safeParse(request.body);
    // A selected person's admin flag never grants additional administrator capabilities.
    if (command.success && command.data.kind.startsWith('admin-')) {
      await reply.code(403).send({ kind: 'failed', code: ClassroomFailure.FORBIDDEN });
    }
  });
  api.addHook('onResponse', async (request, reply) => {
    const identity = identities.get(request.headers);
    if (identity) {
      log.info(
        {
          actorId: identity.actorId,
          subjectId: identity.userId,
          requestId: request.id,
          route: request.routeOptions.url,
          operation: readOperation(request),
          statusCode: reply.statusCode,
        },
        'classroom.view_as.completed',
      );
    }
  });
  return async (headers) => identities.get(headers)?.userId ?? (await readSignedInUserId(headers));
}

function readOperation(request: FastifyRequest): string | null {
  const schema =
    request.routeOptions.url === '/api/v1/classroom/materials'
      ? MaterialCommandSchema
      : request.routeOptions.url === '/api/v1/classroom/practice'
        ? PracticeCommandSchema
        : request.routeOptions.url === '/api/v1/classroom/insights'
          ? ClassroomInsightCommandSchema
          : ClassroomCommandSchema;
  const parsed = schema.safeParse(request.body);
  return parsed.success ? parsed.data.kind : null;
}
