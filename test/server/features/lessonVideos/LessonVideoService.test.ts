import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  LessonCommand,
  LessonLayout,
  LessonVideoFailure,
  LessonVideoStatus,
  type LessonContent,
} from '#contracts/LessonVideos.js';
import {
  LessonModelAttemptState,
  LessonModelRole,
  LessonVisualDegradation,
  LessonVisualStatus,
  LessonVisualTreatment,
  type LessonModelAttempt,
} from '#contracts/LessonVisuals.js';
import {
  LessonVideoService,
  readLessonView,
} from '../../../../src/server/features/lessonVideos/application/LessonVideoService.js';
import type {
  LessonSources,
  StoredLesson,
} from '../../../../src/server/features/lessonVideos/application/LessonVideoPorts.js';
import { estimateLessonReservation } from '../../../../src/server/features/lessonVideos/application/LessonVideoBudget.js';
import { createLessonFixture, createLessonPorts } from './LessonVideoFixtures.js';

function createAttempt(
  role: LessonModelAttempt['role'],
  screenId: string | null = null,
): LessonModelAttempt {
  return {
    id: randomUUID(),
    role,
    screenId,
    ordinal: 1,
    requestDigest: 'a'.repeat(64),
    inputTokenLimit: 12000,
    outputTokenLimit: 6000,
    state: LessonModelAttemptState.DISPATCHED,
    usage: null,
    usageUncertain: true,
  };
}

function createService(lesson: StoredLesson) {
  const ports = createLessonPorts(lesson);
  const sources = {
    authorize: vi.fn<LessonSources['authorize']>().mockResolvedValue(),
    read: vi.fn<LessonSources['read']>().mockResolvedValue(lesson.sources),
    list: vi.fn<LessonSources['list']>().mockResolvedValue([]),
  } satisfies LessonSources;
  const service = new LessonVideoService(
    ports.store,
    sources,
    ports.content,
    ports.renderer,
    lesson.settings,
    randomUUID,
    (value) => createHash('sha256').update(value).digest('hex'),
  );
  return { ...ports, service };
}

function createSavedLesson(): StoredLesson {
  const lesson = createLessonFixture();
  lesson.status = LessonVideoStatus.STOPPED;
  lesson.screens = Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(),
    layout: LessonLayout.EXAMPLE,
    title: `Choice ${String(index + 1)}`,
    points: [`There are ${String(index + 1)} choices.`],
    narration: `Explain choice ${String(index + 1)}.`,
    audioId: randomUUID(),
    clipId: randomUUID(),
    silent: false,
    durationSeconds: 8,
    speechAttempts: 2,
    renderAttempts: 1,
    visual: {
      treatment: LessonVisualTreatment.CUSTOM,
      status: LessonVisualStatus.READY,
      degradationReason: null,
    },
  }));
  lesson.visuals = lesson.screens.map((screen, index) => ({
    screenId: screen.id,
    brief: {
      position: index,
      objective: 'Count choices.',
      description: 'Group the possible choices.',
      priority: index + 1,
    },
    sourceId: randomUUID(),
    sourceDigest: 'b'.repeat(64),
    inputDigest: 'c'.repeat(64),
    sourceComplete: true,
    diagnostic: null,
  }));
  lesson.modelAttempts = [
    createAttempt(LessonModelRole.CONTENT),
    ...lesson.screens.map((screen) => createAttempt(LessonModelRole.VISUAL, screen.id)),
  ];
  return lesson;
}

function readContent(lesson: StoredLesson): LessonContent {
  return {
    title: lesson.title,
    screens: lesson.screens.map(({ layout, title, points, narration }) => ({
      layout,
      title,
      points,
      narration,
    })),
  };
}

it('reserves the full writer and visual allowance before a small content request', async () => {
  const initial = createLessonFixture();
  const ports = createService(initial);
  await ports.service.execute(initial.ownerId, {
    kind: LessonCommand.CREATE,
    requestId: randomUUID(),
    classId: initial.classId,
    materialIds: initial.sources.map((source) => source.id),
    prompt: 'Explain choices.',
    locale: 'en',
  });
  expect(ports.readSaved()).toMatchObject({
    stateVersion: 2,
    modelAttempts: [],
    visuals: [],
    reservedMicroUsd: 144000,
  });
  expect(estimateLessonReservation(initial.settings)).toBe(144000);
  expect(ports.content.generate).not.toHaveBeenCalled();
});

it('continues a version-two writer with its original remaining slot after an uncertain dispatch', async () => {
  const lesson = createLessonFixture();
  lesson.status = LessonVideoStatus.STOPPED;
  lesson.error = LessonVideoFailure.CONTENT;
  lesson.contentStarted = true;
  lesson.modelAttempts = [createAttempt(LessonModelRole.CONTENT)];
  const ports = createService(lesson);
  expect(readLessonView(lesson).canContinue).toBe(true);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.CONTINUE,
    id: lesson.id,
    revision: lesson.revision,
  });
  expect(ports.readSaved()).toMatchObject({
    status: LessonVideoStatus.QUEUED,
    contentStarted: true,
  });
  expect(ports.readSaved().modelAttempts).toEqual(lesson.modelAttempts);
  expect(ports.readSaved().reservedMicroUsd).toBe(lesson.reservedMicroUsd);
  expect(ports.content.generate).not.toHaveBeenCalled();
});

it('does not invent a writer retry for legacy unknown usage or an exhausted saved allowance', async () => {
  const initial = createLessonFixture();
  const first = createAttempt(LessonModelRole.CONTENT);
  for (const lesson of [
    { ...initial, stateVersion: 1, modelAttempts: [] },
    { ...initial, modelAttempts: [first, { ...first, id: randomUUID(), ordinal: 2 }] },
  ]) {
    lesson.status = LessonVideoStatus.STOPPED;
    lesson.contentStarted = true;
    const ports = createService(lesson);
    expect(readLessonView(lesson).canContinue).toBe(false);
    await expect(
      ports.service.execute(lesson.ownerId, {
        kind: LessonCommand.CONTINUE,
        id: lesson.id,
        revision: lesson.revision,
      }),
    ).rejects.toMatchObject({ code: LessonVideoFailure.CONTENT });
    expect(ports.store.saveStageResult).not.toHaveBeenCalled();
    expect(ports.content.generate).not.toHaveBeenCalled();
  }
});

it('can continue a legacy job that never dispatched its writer', async () => {
  const lesson = createLessonFixture();
  lesson.stateVersion = 1;
  lesson.status = LessonVideoStatus.STOPPED;
  lesson.contentStarted = false;
  const ports = createService(lesson);
  expect(readLessonView(lesson).canContinue).toBe(true);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.CONTINUE,
    id: lesson.id,
    revision: lesson.revision,
  });
  expect(ports.readSaved().status).toBe(LessonVideoStatus.QUEUED);
  expect(ports.readSaved().stateVersion).toBe(1);
  expect(ports.readSaved().modelAttempts).toEqual([]);
});

it('reuses server IDs, source and media when unchanged scenes are reordered', async () => {
  const lesson = createSavedLesson();
  const content = readContent(lesson);
  content.screens.reverse();
  const ports = createService(lesson);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.EDIT,
    id: lesson.id,
    revision: lesson.revision,
    content,
  });
  expect(ports.readSaved().screens).toEqual([...lesson.screens].reverse());
  expect(ports.readSaved().visuals).toEqual(lesson.visuals);
  expect(ports.readSaved().modelAttempts).toEqual(lesson.modelAttempts);
  expect(ports.content.generate).not.toHaveBeenCalled();
});

it('invalidates only edited scene source and media without renewing its AI attempts', async () => {
  const lesson = createSavedLesson();
  lesson.renderRecoveries = 1;
  const content = readContent(lesson);
  content.screens = content.screens.map((screen, index) =>
    index === 0 ? { ...screen, narration: 'Updated explanation.' } : screen,
  );
  const ports = createService(lesson);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.EDIT,
    id: lesson.id,
    revision: lesson.revision,
    content,
  });
  const saved = ports.readSaved();
  expect(saved.screens[0]).toMatchObject({
    id: lesson.screens[0]?.id,
    audioId: null,
    clipId: null,
    durationSeconds: 0,
    silent: true,
    speechAttempts: 2,
    visual: {
      treatment: LessonVisualTreatment.BASELINE,
      status: LessonVisualStatus.DEGRADED,
      degradationReason: LessonVisualDegradation.EDITED,
    },
  });
  expect(saved.visuals[0]).toMatchObject({
    sourceId: null,
    sourceComplete: false,
    inputDigest: null,
  });
  expect(saved.screens.slice(1)).toEqual(lesson.screens.slice(1));
  expect(saved.visuals.slice(1)).toEqual(lesson.visuals.slice(1));
  expect(saved.modelAttempts).toEqual(lesson.modelAttempts);
  expect(saved.reservedMicroUsd).toBe(lesson.reservedMicroUsd);
  expect(saved.renderRecoveries).toBe(0);
});

it('degrades stale custom source after a renderer build change while preserving attempts', async () => {
  const lesson = createSavedLesson();
  lesson.renderRecoveries = 1;
  const ports = createService(lesson);
  ports.renderer.readBuildId.mockResolvedValue('renderer-v2');
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.CONTINUE,
    id: lesson.id,
    revision: lesson.revision,
  });
  const saved = ports.readSaved();
  expect(saved.rendererBuild).toBe('renderer-v2');
  expect(saved.screens.every((screen) => screen.clipId === null)).toBe(true);
  expect(
    saved.screens.every((screen) => screen.visual?.status === LessonVisualStatus.DEGRADED),
  ).toBe(true);
  expect(saved.visuals.every((visual) => visual.sourceId === null)).toBe(true);
  expect(saved.modelAttempts).toEqual(lesson.modelAttempts);
  expect(saved.renderRecoveries).toBe(0);
});

it('uses standard animation when adding narration can change saved scene timing', async () => {
  const lesson = createSavedLesson();
  lesson.screens = lesson.screens.map((screen, index) =>
    index === 0 ? { ...screen, silent: true, audioId: null } : screen,
  );
  const ports = createService(lesson);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.NARRATE,
    id: lesson.id,
    revision: lesson.revision,
  });
  const saved = ports.readSaved();
  expect(saved.screens[0]).toMatchObject({
    silent: false,
    clipId: null,
    visual: {
      treatment: LessonVisualTreatment.BASELINE,
      status: LessonVisualStatus.DEGRADED,
      degradationReason: LessonVisualDegradation.EDITED,
    },
  });
  expect(saved.visuals[0]?.sourceId).toBeNull();
  expect(saved.screens.slice(1)).toEqual(lesson.screens.slice(1));
  expect(saved.visuals.slice(1)).toEqual(lesson.visuals.slice(1));
  expect(saved.modelAttempts).toEqual(lesson.modelAttempts);
});

it('preserves consumed clip and combine attempts when Continue uses remaining media headroom', async () => {
  const lesson = createSavedLesson();
  lesson.screens = lesson.screens.map((screen, index) =>
    index === 0 ? { ...screen, clipId: null, renderAttempts: 1 } : screen,
  );
  lesson.combineAttempts = 2;
  const ports = createService(lesson);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.CONTINUE,
    id: lesson.id,
    revision: lesson.revision,
  });
  expect(ports.readSaved().renderRecoveries).toBe(0);
  expect(ports.readSaved().screens[0]?.renderAttempts).toBe(1);
  expect(ports.readSaved().combineAttempts).toBe(2);
  expect(ports.readSaved().modelAttempts).toEqual(lesson.modelAttempts);
});

it('grants one saved media recovery without resetting counts and hides Continue at the cumulative ceiling', async () => {
  const lesson = createSavedLesson();
  lesson.screens = lesson.screens.map((screen, index) =>
    index === 0 ? { ...screen, clipId: null, renderAttempts: 3 } : screen,
  );
  lesson.combineAttempts = 1;
  const ports = createService(lesson);
  expect(readLessonView(lesson).canContinue).toBe(true);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.CONTINUE,
    id: lesson.id,
    revision: lesson.revision,
  });
  const resumed = ports.readSaved();
  expect(resumed.renderRecoveries).toBe(1);
  expect(resumed.screens[0]?.renderAttempts).toBe(3);
  expect(resumed.combineAttempts).toBe(1);
  expect(resumed.modelAttempts).toEqual(lesson.modelAttempts);
  const exhausted = {
    ...resumed,
    status: LessonVideoStatus.STOPPED,
    screens: resumed.screens.map((screen, index) =>
      index === 0 ? { ...screen, renderAttempts: 6 } : screen,
    ),
  };
  const exhaustedPorts = createService(exhausted);
  expect(readLessonView(exhausted).canContinue).toBe(false);
  await expect(
    exhaustedPorts.service.execute(lesson.ownerId, {
      kind: LessonCommand.CONTINUE,
      id: lesson.id,
      revision: lesson.revision,
    }),
  ).rejects.toMatchObject({ code: LessonVideoFailure.STALE });
  expect(exhaustedPorts.store.saveStageResult).not.toHaveBeenCalled();
});

it('counts combination recovery against the same saved allowance', async () => {
  const lesson = createSavedLesson();
  lesson.combineAttempts = 3;
  const ports = createService(lesson);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.CONTINUE,
    id: lesson.id,
    revision: lesson.revision,
  });
  expect(ports.readSaved().renderRecoveries).toBe(1);
  expect(ports.readSaved().combineAttempts).toBe(3);
  expect(ports.readSaved().screens).toEqual(lesson.screens);
  expect(
    readLessonView({ ...ports.readSaved(), status: LessonVideoStatus.STOPPED, combineAttempts: 6 })
      .canContinue,
  ).toBe(false);
});

it('does not add manual media recovery to legacy jobs whose saved policy has none', async () => {
  const lesson = createSavedLesson();
  lesson.settings.render.recoveries = 0;
  lesson.screens = lesson.screens.map((screen, index) =>
    index === 0 ? { ...screen, clipId: null, renderAttempts: 3 } : screen,
  );
  const ports = createService(lesson);
  expect(readLessonView(lesson).canContinue).toBe(false);
  await expect(
    ports.service.execute(lesson.ownerId, {
      kind: LessonCommand.CONTINUE,
      id: lesson.id,
      revision: lesson.revision,
    }),
  ).rejects.toMatchObject({ code: LessonVideoFailure.STALE });
  expect(ports.store.saveStageResult).not.toHaveBeenCalled();
});

it('does not offer media recovery when the current revision already has a completed video', () => {
  const lesson = createSavedLesson();
  lesson.videoId = randomUUID();
  lesson.videoRevision = lesson.revision;
  lesson.status = LessonVideoStatus.CANCELLED;
  expect(readLessonView(lesson).canContinue).toBe(false);
});

it('gives explicitly edited revisions fresh unfinished media counts while retaining completed clips and AI history', async () => {
  const lesson = createSavedLesson();
  lesson.renderRecoveries = 1;
  lesson.screens = lesson.screens.map((screen, index) =>
    index === 0 ? { ...screen, clipId: null, renderAttempts: 6 } : screen,
  );
  const content = readContent(lesson);
  content.screens = content.screens.map((screen, index) =>
    index === 1 ? { ...screen, title: 'Updated title' } : screen,
  );
  const ports = createService(lesson);
  await ports.service.execute(lesson.ownerId, {
    kind: LessonCommand.EDIT,
    id: lesson.id,
    revision: lesson.revision,
    content,
  });
  expect(ports.readSaved().renderRecoveries).toBe(0);
  expect(ports.readSaved().screens[0]?.renderAttempts).toBe(0);
  expect(ports.readSaved().screens[1]?.renderAttempts).toBe(0);
  expect(ports.readSaved().screens[2]).toEqual(lesson.screens[2]);
  expect(ports.readSaved().modelAttempts).toEqual(lesson.modelAttempts);
});

it('does not offer a recovery that still cannot fit an outstanding saved operation', () => {
  const lesson = createSavedLesson();
  lesson.renderRecoveries = 0;
  lesson.screens = lesson.screens.map((screen, index) =>
    index === 0 ? { ...screen, clipId: null, renderAttempts: 6 } : screen,
  );
  expect(readLessonView(lesson).canContinue).toBe(false);
});
