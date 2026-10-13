import type { FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import {
  LessonVideoCommandSchema,
  LessonVideoReplySchema,
  LessonVideoFailure,
  LessonArtifactKind,
} from '#contracts/LessonVideos.js';
import { LessonVideoError } from '../domain/LessonVideoRules.js';
import type { LessonVideoService } from '../application/LessonVideoService.js';

/** Authenticated public boundary. Artifact IDs never authorize their own download. */
export function registerLessonVideoRoutes(
  app: FastifyInstance,
  readUserId: (headers: IncomingHttpHeaders) => Promise<string | null>,
  service: LessonVideoService,
  wake: () => void,
): void {
  app.post('/api/v1/lesson-videos', { bodyLimit: 64000 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const ownerId = await readUserId(request.headers);
    if (!ownerId) {
      return await reply.code(401).send({ kind: 'failed', code: LessonVideoFailure.FORBIDDEN });
    }
    const command = LessonVideoCommandSchema.safeParse(request.body);
    if (!command.success) {
      return await reply.code(400).send({ kind: 'failed', code: LessonVideoFailure.INVALID });
    }
    try {
      const result = LessonVideoReplySchema.parse(await service.execute(ownerId, command.data));
      wake();
      return result;
    } catch (error) {
      const code = error instanceof LessonVideoError ? error.code : LessonVideoFailure.UNAVAILABLE;
      return await reply
        .code(
          code === LessonVideoFailure.FORBIDDEN
            ? 403
            : code === LessonVideoFailure.STALE
              ? 409
              : code === LessonVideoFailure.BUDGET
                ? 429
                : 503,
        )
        .send({ kind: 'failed', code });
    }
  });
  app.get('/api/v1/lesson-videos/:id/artifacts/:artifactId', async (request, reply) => {
    const ownerId = await readUserId(request.headers);
    const parameters = z
      .strictObject({ id: z.uuid(), artifactId: z.uuid() })
      .safeParse(request.params);
    if (!ownerId || !parameters.success) {
      return await reply.code(403).send();
    }
    try {
      await service.readOwnedLesson(ownerId, parameters.data.id);
      const artifact = await service.store.readArtifact(
        parameters.data.id,
        parameters.data.artifactId,
      );
      if (
        !artifact ||
        (artifact.kind !== LessonArtifactKind.AUDIO &&
          artifact.kind !== LessonArtifactKind.CLIP &&
          artifact.kind !== LessonArtifactKind.VIDEO)
      ) {
        return await reply.code(404).send();
      }
      const bytes = Buffer.from(artifact.bytes);
      reply
        .header('cache-control', 'no-store')
        .header('accept-ranges', 'bytes')
        .type(artifact.kind === LessonArtifactKind.AUDIO ? 'audio/wav' : 'video/mp4');
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        const start = Number(match?.[1]);
        const end = match?.[2] ? Number(match[2]) : bytes.length - 1;
        if (
          !match ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end < start ||
          end >= bytes.length
        ) {
          return await reply
            .code(416)
            .header('content-range', `bytes */${String(bytes.length)}`)
            .send();
        }
        return await reply
          .code(206)
          .header('content-range', `bytes ${String(start)}-${String(end)}/${String(bytes.length)}`)
          .send(bytes.subarray(start, end + 1));
      }
      return await reply.send(bytes);
    } catch {
      return await reply.code(403).send();
    }
  });
}
