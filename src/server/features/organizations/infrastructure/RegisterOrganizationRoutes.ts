import { OrganizationLogoLimits } from '#contracts/OrganizationLogo.js';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  OrganizationAction,
  OrganizationCommandSchema,
  OrganizationFailure,
  OrganizationReplySchema,
} from '#contracts/Organizations.js';
import type { OrganizationService } from '../application/OrganizationService.js';
import { OrganizationError } from '../domain/OrganizationError.js';
import { OrganizationInvitationAttempts } from './OrganizationInvitationAttempts.js';

/** Session identity, bounded input and persisted service authorization precede every operation. */
export function registerOrganizationRoutes(
  api: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  service: Pick<OrganizationService, 'execute'>,
  log: Pick<Logger, 'warn' | 'error'>,
): void {
  const invitationAttempts = new OrganizationInvitationAttempts();
  api.post(
    '/api/v1/organizations/command',
    { bodyLimit: OrganizationLogoLimits.REQUEST_BYTES },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const userId = await readUserId(request.headers);
      if (!userId) {
        return reply.code(401).send({ kind: 'failed', code: OrganizationFailure.UNAUTHORIZED });
      }
      const parsed = OrganizationCommandSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ kind: 'failed', code: OrganizationFailure.INVALID });
      }
      if (
        parsed.data.kind === OrganizationAction.ACCEPT_INVITATION &&
        !invitationAttempts.canAttempt(userId, Date.now())
      ) {
        return reply.code(429).send({ kind: 'failed', code: OrganizationFailure.UNAVAILABLE });
      }
      try {
        return OrganizationReplySchema.parse(await service.execute(userId, parsed.data));
      } catch (error: unknown) {
        const code =
          error instanceof OrganizationError ? error.code : OrganizationFailure.UNAVAILABLE;
        log.warn(
          { operation: parsed.data.kind, code, requestId: request.id },
          'organization.command.refused',
        );
        if (!(error instanceof OrganizationError)) {
          log.error(
            {
              operation: parsed.data.kind,
              requestId: request.id,
              errorType: error instanceof Error ? error.name : typeof error,
            },
            'organization.command.failed',
          );
        }
        const status =
          code === OrganizationFailure.UNAUTHORIZED
            ? 401
            : code === OrganizationFailure.FORBIDDEN
              ? 403
              : code === OrganizationFailure.NOT_FOUND
                ? 404
                : code === OrganizationFailure.CONFLICT
                  ? 409
                  : code === OrganizationFailure.INVALID
                    ? 400
                    : 503;
        return reply.code(status).send({ kind: 'failed', code });
      }
    },
  );
}
