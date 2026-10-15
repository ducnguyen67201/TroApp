import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ClassroomCommandSchema } from '#contracts/Classroom.js';
import { MaterialCommandSchema } from '#contracts/ClassroomMaterials.js';
import { PracticeCommandSchema } from '#contracts/PracticeCheck.js';
import { ClassroomInsightCommandSchema } from '#contracts/ClassroomInsights.js';
import { LessonVideoCommandSchema } from '#contracts/LessonVideos.js';
import { PetWorldCommandSchema } from '#contracts/PetWorld.js';
import { StudentAccessCommandSchema } from '#contracts/StudentAccess.js';
import { AdminOrganization } from '#contracts/AdminOrganization.js';
import { OrganizationCommandSchema, OrganizationFailure } from '#contracts/Organizations.js';
import { adminOrganizationContext } from './AdminOrganizationContext.js';
import type { OrganizationStore } from '../features/organizations/application/OrganizationStore.js';

/** Keeps the authenticated actor and isolates concurrent requests to their verified organization. */
export function registerAdminOrganization(
  api: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  store: Pick<OrganizationStore, 'readAccount' | 'readOrganization'>,
  log: Pick<Logger, 'info' | 'warn'>,
): void {
  api.addHook('onRequest', (request, reply, done) => {
    const raw = request.headers[AdminOrganization.HEADER];
    if (request.headers['x-tro-classroom-view-as'] !== undefined) {
      void reply.code(403).send({ kind: 'failed', code: OrganizationFailure.FORBIDDEN });
      return;
    }
    if (raw === undefined) {
      adminOrganizationContext.run(undefined, done);
      return;
    }
    void (async () => {
      const scope = z.uuid().safeParse(raw);
      const actorId = await readUserId(request.headers);
      const actor = actorId ? await store.readAccount(actorId) : null;
      if (!scope.success || !actor?.isAdmin || !(await store.readOrganization(scope.data))) {
        log.warn({ requestId: request.id, actorId }, 'organization.admin.refused');
        await reply.code(403).send({ kind: 'failed', code: OrganizationFailure.FORBIDDEN });
        return;
      }
      adminOrganizationContext.run({ actorId: actor.id, organizationId: scope.data }, done);
    })().catch(() => {
      log.warn({ requestId: request.id }, 'organization.admin.authorization_failed');
      void reply.code(503).send({ kind: 'failed', code: OrganizationFailure.UNAVAILABLE });
    });
  });
  api.addHook('onResponse', async (request, reply) => {
    const context = adminOrganizationContext.getStore();
    if (context && request.method !== 'GET') {
      const body = z
        .union([
          OrganizationCommandSchema,
          ClassroomCommandSchema,
          MaterialCommandSchema,
          PracticeCommandSchema,
          ClassroomInsightCommandSchema,
          LessonVideoCommandSchema,
          PetWorldCommandSchema,
          StudentAccessCommandSchema,
        ])
        .safeParse(request.body);
      if (
        body.success &&
        ![
          'home',
          'team',
          'list',
          'options',
          'read',
          'context',
          'resume',
          'session-roster',
          'teacher-history',
          'overview',
          'status',
          'organization-access',
          'own-world',
          'class-neighborhood',
          'class-roster',
        ].includes(body.data.kind)
      ) {
        log.info(
          {
            ...context,
            requestId: request.id,
            route: request.routeOptions.url,
            operation: body.data.kind,
            statusCode: reply.statusCode,
          },
          'organization.admin.completed',
        );
      }
    }
  });
}
