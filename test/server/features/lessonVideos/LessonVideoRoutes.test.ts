import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { registerLessonVideoRoutes } from '../../../../src/server/features/lessonVideos/infrastructure/RegisterLessonVideoRoutes.js';
import { LessonVideoService } from '../../../../src/server/features/lessonVideos/application/LessonVideoService.js';
import { createLessonFixture, createLessonPorts } from './LessonVideoFixtures.js';

it('rejects unauthenticated generation and artifact access before calling application ports', async () => {
  const lesson = createLessonFixture();
  const ports = createLessonPorts(lesson);
  const sources = {
    authorize: vi.fn(() => Promise.resolve()),
    read: vi.fn(() => Promise.resolve(lesson.sources)),
    list: vi.fn(() => Promise.resolve([])),
  };
  const service = new LessonVideoService(
    ports.store,
    sources,
    ports.content,
    ports.renderer,
    lesson.settings,
    randomUUID,
    (value) => value,
  );
  const app = Fastify();
  registerLessonVideoRoutes(app, () => Promise.resolve(null), service, vi.fn());
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/lesson-videos',
          payload: { kind: 'list' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/lesson-videos/${lesson.id}/artifacts/${randomUUID()}`,
        })
      ).statusCode,
    ).toBe(403);
    expect(ports.store.list).not.toHaveBeenCalled();
    expect(ports.content.generate).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
