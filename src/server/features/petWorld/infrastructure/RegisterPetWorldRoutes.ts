import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  PetWorldCommandSchema,
  PetWorldFailure,
  PetWorldReplySchema,
} from '#contracts/PetWorld.js';
import type { PetWorldService } from '../application/PetWorldService.js';
import { PetWorldError } from '../domain/PetWorldError.js';

function readFailureStatus(code: PetWorldFailure): number {
  switch (code) {
    case PetWorldFailure.UNAUTHORIZED:
      return 401;
    case PetWorldFailure.FORBIDDEN:
    case PetWorldFailure.HOME_UNAVAILABLE:
      return 403;
    case PetWorldFailure.INVALID:
      return 400;
    case PetWorldFailure.UNAVAILABLE:
      return 503;
    default:
      return 409;
  }
}

/** Authenticated manual HTTP commands; intentionally absent from agent/worker tools. */
export function registerPetWorldRoutes(
  api: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  service: PetWorldService,
  log: Pick<Logger, 'warn' | 'error'>,
): void {
  api.post('/api/v1/pet-world/command', { bodyLimit: 35_000 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actorId = await readUserId(request.headers);
    if (!actorId) {
      return reply.code(401).send({ kind: 'failed', code: PetWorldFailure.UNAUTHORIZED });
    }
    const parsed = PetWorldCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ kind: 'failed', code: PetWorldFailure.INVALID });
    }
    const startedAt = Date.now();
    try {
      return PetWorldReplySchema.parse(await service.execute(actorId, parsed.data));
    } catch (error: unknown) {
      const code = error instanceof PetWorldError ? error.code : PetWorldFailure.UNAVAILABLE;
      const details = {
        operation: parsed.data.kind,
        code,
        requestId: request.id,
        intentId: 'requestId' in parsed.data ? parsed.data.requestId : undefined,
        durationMs: Date.now() - startedAt,
      };
      log.warn(details, 'petWorld.command.refused');
      if (!(error instanceof PetWorldError)) {
        log.error(
          { ...details, errorType: error instanceof Error ? error.name : typeof error },
          'petWorld.command.failed',
        );
      }
      return reply.code(readFailureStatus(code)).send({ kind: 'failed', code });
    }
  });
}
