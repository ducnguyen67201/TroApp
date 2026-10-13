import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaLessonVideoStore } from '../../../src/server/persistence/PrismaLessonVideoStore.js';
import {
  LessonVideoStatus,
  LessonArtifactKind,
  LessonLayout,
} from '../../../src/contracts/LessonVideos.js';
import {
  LessonModelAttemptState,
  LessonModelRole,
  LessonVisualStatus,
  LessonVisualTreatment,
} from '../../../src/contracts/LessonVisuals.js';
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
    saved = await first.saveStageResult({ ...saved, renderRecoveries: 1 });
    await expect(second.saveStageResult({ ...saved, renderRecoveries: 0 })).rejects.toMatchObject({
      code: 'stale',
    });
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

it('admits one concurrent last writer slot, persists its receipt and prevents paid-ledger erasure', async () => {
  const environment = readServerEnv(process.env);
  const first = createPrismaLessonVideoStore(environment.DATABASE_URL);
  const second = createPrismaLessonVideoStore(environment.DATABASE_URL);
  const lesson = createLessonFixture();
  lesson.contentStarted = true;
  lesson.modelAttempts = [
    {
      id: randomUUID(),
      role: LessonModelRole.CONTENT,
      screenId: null,
      ordinal: 1,
      requestDigest: 'a'.repeat(64),
      inputTokenLimit: 1000,
      outputTokenLimit: lesson.settings.content.outputTokens,
      state: LessonModelAttemptState.INCOMPLETE,
      usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0, requestId: 'first-response' },
      usageUncertain: false,
    },
  ];
  try {
    const saved = await first.createLessonWithReservation(lesson);
    const attempts = [randomUUID(), randomUUID()].map((id) => ({
      id,
      role: LessonModelRole.CONTENT,
      screenId: null,
      ordinal: 2,
      requestDigest: 'b'.repeat(64),
      inputTokenLimit: 1000,
      outputTokenLimit: lesson.settings.content.outputTokens,
      state: LessonModelAttemptState.DISPATCHED,
      usage: null,
      usageUncertain: true,
    }));
    const firstAttempt = attempts[0];
    const secondAttempt = attempts[1];
    if (!firstAttempt || !secondAttempt) {
      throw new Error('Concurrent attempt fixtures are missing.');
    }
    const results = await Promise.allSettled([
      first.beginModelAttempt(saved, firstAttempt),
      second.beginModelAttempt(saved, secondAttempt),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const current = await second.read(lesson.id);
    const dispatched = current?.modelAttempts[1];
    if (!current || !dispatched) {
      throw new Error('The winning attempt was not persisted.');
    }
    expect(current.modelAttempts).toHaveLength(2);
    const usage = {
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 100,
      requestId: 'second-response',
    };
    const settled = await first.saveModelAttemptResult(current, dispatched.id, {
      state: LessonModelAttemptState.COMPLETED,
      usage,
      usageUncertain: false,
    });
    expect((await second.read(lesson.id))?.modelAttempts[1]?.usage).toEqual(usage);
    expect(settled.inputTokens).toBe(2200);
    expect(settled.outputTokens).toBe(500);
    await expect(
      first.saveStageResult({ ...settled, revision: settled.revision + 1, modelAttempts: [] }),
    ).rejects.toMatchObject({ code: 'stale' });
    const unchanged = await second.read(lesson.id);
    expect(unchanged?.revision).toBe(settled.revision);
    expect(unchanged?.modelAttempts).toHaveLength(2);
    await expect(
      second.beginModelAttempt(settled, { ...firstAttempt, id: randomUUID(), ordinal: 3 }),
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

it('commits private source, its checkpoint and usage together or rolls every change back', async () => {
  const environment = readServerEnv(process.env);
  const first = createPrismaLessonVideoStore(environment.DATABASE_URL);
  const second = createPrismaLessonVideoStore(environment.DATABASE_URL);
  const lesson = createLessonFixture();
  lesson.settings.render.maxStoredBytes = 20;
  const screenId = randomUUID();
  const sourceId = randomUUID();
  const sourceBytes = new TextEncoder().encode('export{}');
  try {
    let saved = await first.createLessonWithReservation(lesson);
    saved = await first.saveStageResult({
      ...saved,
      screens: [
        {
          id: screenId,
          layout: LessonLayout.EXAMPLE,
          title: 'True and false',
          points: ['Only two values.'],
          narration: 'Boolean has two values.',
          audioId: null,
          clipId: null,
          silent: true,
          durationSeconds: 5,
          speechAttempts: 1,
          renderAttempts: 0,
          visual: {
            treatment: LessonVisualTreatment.CUSTOM,
            status: LessonVisualStatus.PENDING,
            degradationReason: null,
          },
        },
      ],
      visuals: [
        {
          screenId,
          brief: {
            position: 0,
            objective: 'Show two values.',
            description: 'Reveal True and False.',
            priority: 1,
          },
          sourceId: null,
          sourceDigest: null,
          inputDigest: null,
          sourceComplete: false,
          diagnostic: null,
        },
      ],
    });
    const attemptId = randomUUID();
    const dispatched = await first.beginModelAttempt(saved, {
      id: attemptId,
      role: LessonModelRole.VISUAL,
      screenId,
      ordinal: 1,
      requestDigest: 'a'.repeat(64),
      inputTokenLimit: 1000,
      outputTokenLimit: lesson.settings.visual.outputTokens,
      state: LessonModelAttemptState.DISPATCHED,
      usage: null,
      usageUncertain: true,
    });
    const checkpoint = {
      ...dispatched,
      visuals: dispatched.visuals.map((visual) => ({
        ...visual,
        sourceId,
        sourceDigest: createHash('sha256').update(sourceBytes).digest('hex'),
        inputDigest: 'c'.repeat(64),
        sourceComplete: true,
      })),
    };
    const result = {
      state: LessonModelAttemptState.COMPLETED,
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cachedTokens: 0,
        requestId: 'source-response',
      },
      usageUncertain: false,
    };
    await expect(
      first.saveModelAttemptResult(checkpoint, attemptId, result, {
        id: sourceId,
        lessonId: lesson.id,
        kind: LessonArtifactKind.SOURCE,
        bytes: new Uint8Array(21),
      }),
    ).rejects.toMatchObject({ code: 'budget' });
    const rolledBack = await second.read(lesson.id);
    expect(rolledBack?.recordVersion).toBe(dispatched.recordVersion);
    expect(rolledBack?.visuals[0]?.sourceId).toBeNull();
    expect(rolledBack?.modelAttempts[0]?.state).toBe(LessonModelAttemptState.DISPATCHED);
    expect(await second.readArtifact(lesson.id, sourceId)).toBeNull();

    await first.saveModelAttemptResult(checkpoint, attemptId, result, {
      id: sourceId,
      lessonId: lesson.id,
      kind: LessonArtifactKind.SOURCE,
      bytes: sourceBytes,
    });
    const committed = await second.read(lesson.id);
    expect(committed?.visuals[0]?.sourceId).toBe(sourceId);
    expect(committed?.modelAttempts[0]?.usage).toEqual(result.usage);
    expect((await second.readArtifact(lesson.id, sourceId))?.kind).toBe(LessonArtifactKind.SOURCE);
    expect(Array.from((await second.readArtifact(lesson.id, sourceId))?.bytes ?? [])).toEqual(
      Array.from(sourceBytes),
    );
  } finally {
    const remaining = await first.read(lesson.id);
    if (remaining) {
      await first.deleteLesson(remaining);
    }
    await first.close();
    await second.close();
  }
});
