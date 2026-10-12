import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaLessonVideoStore } from '../../../src/server/persistence/PrismaLessonVideoStore.js';
import { LessonVideoStatus, LessonArtifactKind } from '../../../src/contracts/LessonVideos.js';
import { createLessonFixture } from '../features/lessonVideos/LessonVideoFixtures.js';

it('deduplicates creation, fences stale workers and retains daily charges after deletion', async () => {
  const environment = readServerEnv(process.env);
  const first = createPrismaLessonVideoStore(environment.DATABASE_URL);
  const second = createPrismaLessonVideoStore(environment.DATABASE_URL);
  const lesson = createLessonFixture();
  lesson.status = LessonVideoStatus.QUEUED;
  lesson.claimId = null;
  lesson.settings.budget.teacherMicroUsd = lesson.reservedMicroUsd;
  const concurrent = await Promise.all([
    first.createLessonWithReservation(lesson),
    second.createLessonWithReservation(lesson),
  ]);
  expect(concurrent[0].id).toBe(concurrent[1].id);
  try {
    const duplicate = await second.createLessonWithReservation(lesson);
    expect(duplicate.id).toBe(lesson.id);
    const firstClaim = await first.claimNextLesson(new Date(), randomUUID());
    expect(firstClaim?.id).toBe(lesson.id);
    if (!firstClaim) {
      throw new Error('Job was not claimed.');
    }
    expect(await second.claimNextLesson(new Date(), randomUUID())).toBeNull();
    let saved = await first.saveStageResult({ ...firstClaim, title: 'Saved title' });
    await expect(second.saveStageResult(firstClaim)).rejects.toMatchObject({ code: 'stale' });
    const artifactId = randomUUID();
    saved = await first.saveStageResult(
      {
        ...saved,
        videoId: artifactId,
        videoRevision: 1,
        status: LessonVideoStatus.READY,
        claimId: null,
      },
      {
        id: artifactId,
        lessonId: lesson.id,
        kind: LessonArtifactKind.VIDEO,
        bytes: new Uint8Array([1, 2, 3]),
      },
    );
    expect((await second.read(lesson.id))?.videoId).toBe(artifactId);
    expect((await second.readArtifact(lesson.id, artifactId))?.bytes.byteLength).toBe(3);
    await first.deleteLesson(saved);
    expect(await second.readArtifact(lesson.id, artifactId)).toBeNull();
    await expect(
      first.createLessonWithReservation({ ...lesson, id: randomUUID(), requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'budget' });
  } finally {
    const remaining = await first.read(lesson.id);
    if (remaining) {
      await first.deleteLesson(remaining);
    }
    await first.close();
    await second.close();
  }
});
