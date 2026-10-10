import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LessonPhase, LessonStatus, type GuidedLessonCommand } from '#contracts/GuidedLessons.js';
import { GuidedLessonService } from '../../../../src/server/features/guidedLessons/application/GuidedLessonService.js';
import type { LessonRecord } from '../../../../src/server/features/guidedLessons/application/LessonState.js';
import type {
  LessonModel,
  LessonRenderer,
  LessonSpeech,
} from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import { LessonProviderNotDispatchedError } from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';
import {
  admitLessonRun,
  reserveLessonAttempt,
  createLessonBudget,
} from '../../../../src/server/features/guidedLessons/application/LessonBudget.js';
import { hashLessonValue } from '../../../../src/server/features/guidedLessons/application/BuildLessonInput.js';
import { createStoredLesson } from './StoredLessonFixture.js';
import { MemoryGuidedLessonStore } from './MemoryGuidedLessonStore.js';

const now = () => new Date('2026-10-09T12:00:00.000Z');

function setup(model?: LessonModel) {
  const store = new MemoryGuidedLessonStore();
  const record = createStoredLesson();
  store.lessons.set(record.id, record);
  store.releases.set('release-1', {
    id: 'release-1',
    lessonId: record.id,
    classId: record.classId,
    available: true,
    releasedAt: now().toISOString(),
    record,
  });
  store.publications.set(record.input.courseRevisionId, {
    classId: record.classId,
    courseId: record.input.courseRevisionId,
    teacherInstructions: '',
    sources: [],
    draft: { summary: '', questions: [], sections: [], pages: [] },
  });
  for (const userId of ['teacher', 'student', 'other']) {
    store.accesses.set(`${userId}:${record.classId}`, {
      classId: record.classId,
      teacherId: 'teacher',
      isTeacher: userId === 'teacher',
      enrolled: userId !== 'teacher',
      courseRevisionId: record.input.courseRevisionId,
    });
  }
  const generation: LessonModel = model ?? {
    countInput: vi.fn<LessonModel['countInput']>().mockResolvedValue(100),
    generate: vi.fn<LessonModel['generate']>().mockResolvedValue({
      result: { status: 'ready', plan: record.plan },
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
  };
  const speech: LessonSpeech = {
    synthesize: vi
      .fn<LessonSpeech['synthesize']>()
      .mockRejectedValue(new Error('Unexpected speech call')),
  };
  const renderer: LessonRenderer = {
    render: vi
      .fn<LessonRenderer['render']>()
      .mockRejectedValue(new Error('Unexpected render call')),
  };
  return {
    store,
    record,
    model: generation,
    generate: vi.spyOn(generation, 'generate'),
    speech,
    renderer,
    service: new GuidedLessonService(store, generation, speech, renderer, now),
  };
}

function studentBase(record: LessonRecord, expectedProgressVersion: number) {
  return {
    commandId: randomUUID(),
    classId: record.classId,
    lessonId: record.id,
    releaseId: 'release-1',
    expectedProgressVersion,
  };
}

describe('guided lesson authorization, learning gates and paid attempt lifecycle', () => {
  it('authorizes home playback without a live meeting and blocks future scenes and revoked enrollment', async () => {
    const fixture = setup();
    const projection = await fixture.service.read('student', {
      action: 'projection',
      classId: fixture.record.classId,
      releaseId: 'release-1',
      sceneId: 'predict',
    });
    expect(projection.kind).toBe('projection');
    if (projection.kind === 'projection') {
      expect(projection.projection.phase).toBe('predict');
      expect(
        projection.projection.visibleTraceStates.some((state) => state.stateView === 'after'),
      ).toBe(false);
      expect(JSON.stringify(projection.projection)).not.toContain('answerRef');
    }
    await expect(
      fixture.service.read('student', {
        action: 'projection',
        classId: fixture.record.classId,
        releaseId: 'release-1',
        sceneId: 'continue',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    fixture.store.accesses.delete(`student:${fixture.record.classId}`);
    await expect(
      fixture.service.read('student', {
        action: 'projection',
        classId: fixture.record.classId,
        releaseId: 'release-1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps wrong answers pending, substitutes approved hints, records assisted correctness and resets reveals', async () => {
    const fixture = setup();
    await fixture.service.execute('student', {
      action: 'progress',
      ...studentBase(fixture.record, 0),
      sceneId: 'predict',
      intent: 'revisit',
      frame: 0,
      reflection: '',
    });
    const wrong = await fixture.service.execute('student', {
      action: 'attempt',
      ...studentBase(fixture.record, 1),
      checkpointId: 'checkpoint-1',
      answer: { kind: 'number', value: 6 },
    });
    expect(wrong.kind === 'projection' && wrong.projection.checkpoint?.state).toBe('attempted');
    const hint = await fixture.service.execute('student', {
      action: 'hint',
      ...studentBase(fixture.record, 2),
      checkpointId: 'checkpoint-1',
    });
    expect(hint.kind).toBe('hint');
    const correct = await fixture.service.execute('student', {
      action: 'attempt',
      ...studentBase(fixture.record, 3),
      checkpointId: 'checkpoint-1',
      answer: { kind: 'number', value: 2 },
    });
    expect(correct.kind === 'projection' && correct.projection.checkpoint?.state).toBe('assisted');
    const retry = await fixture.service.execute('student', {
      action: 'progress',
      ...studentBase(fixture.record, 4),
      sceneId: 'predict',
      intent: 'retry',
      frame: 0,
      reflection: '',
    });
    expect(retry.kind === 'projection' && retry.projection.phase).toBe('predict');
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it('replays idempotent commands but refuses body reuse and stale progress', async () => {
    const fixture = setup();
    const command: GuidedLessonCommand = {
      action: 'progress',
      ...studentBase(fixture.record, 0),
      sceneId: 'predict',
      intent: 'revisit',
      frame: 0,
      reflection: '',
    };
    const first = await fixture.service.execute('student', command);
    expect(await fixture.service.execute('student', command)).toEqual(first);
    await expect(
      fixture.service.execute('student', { ...command, frame: 1 }),
    ).rejects.toMatchObject({ code: 'versionConflict' });
    await expect(
      fixture.service.execute('student', { ...command, commandId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'versionConflict' });
  });

  it('keeps private notes separate across students and rejects a fabricated anchor', async () => {
    const fixture = setup();
    const note = {
      noteId: randomUUID(),
      expectedVersion: 0,
      anchor: {
        releaseId: 'release-1',
        sceneId: 'watch',
        phase: 'watch' as const,
        frame: 0,
        traceEventId: null,
        sourceRef: null,
      },
      text: 'My private reminder',
      isBookmark: true,
    };
    await fixture.service.execute('student', {
      action: 'saveNote',
      ...studentBase(fixture.record, 0),
      note,
    });
    const other = await fixture.service.read('other', {
      action: 'notes',
      classId: fixture.record.classId,
      releaseId: 'release-1',
    });
    expect(other).toEqual({ kind: 'notes', notes: [] });
    await expect(
      fixture.service.execute('student', {
        action: 'saveNote',
        ...studentBase(fixture.record, 1),
        note: { ...note, noteId: randomUUID(), anchor: { ...note.anchor, phase: 'worked' } },
      }),
    ).rejects.toMatchObject({ code: 'invalidPlan' });
  });

  it('restores a saved pending note phase after reveal and rejects a worked note after Retry', async () => {
    const fixture = setup();
    await fixture.service.execute('student', {
      action: 'progress',
      ...studentBase(fixture.record, 0),
      sceneId: 'predict',
      intent: 'revisit',
      frame: 0,
      reflection: '',
    });
    const note = {
      noteId: randomUUID(),
      expectedVersion: 0,
      anchor: {
        releaseId: 'release-1',
        sceneId: 'predict',
        phase: 'predict' as const,
        frame: 4,
        traceEventId: null,
        sourceRef: null,
      },
      text: 'Predict before revealing',
      isBookmark: true,
    };
    await fixture.service.execute('student', {
      action: 'saveNote',
      ...studentBase(fixture.record, 1),
      note,
    });
    await fixture.service.execute('student', {
      action: 'attempt',
      ...studentBase(fixture.record, 2),
      checkpointId: 'checkpoint-1',
      answer: { kind: 'number', value: 2 },
    });
    const revisited = await fixture.service.execute('student', {
      action: 'progress',
      ...studentBase(fixture.record, 3),
      sceneId: 'predict',
      intent: 'revisit',
      noteId: note.noteId,
      frame: 0,
      reflection: '',
    });
    expect(revisited.kind === 'projection' && revisited.projection.phase).toBe('predict');
    expect(fixture.store.progress.get('student:release-1')?.frame).toBe(4);
    const refreshed = await fixture.service.read('student', {
      action: 'projection',
      classId: fixture.record.classId,
      releaseId: 'release-1',
    });
    expect(refreshed.kind === 'projection' && refreshed.projection.phase).toBe('predict');
    const pendingHelp = await fixture.service.execute('student', {
      action: 'help',
      ...studentBase(fixture.record, 4),
      sceneId: 'predict',
      message: 'Tell me the answer.',
    });
    expect(pendingHelp.kind).toBe('hint');
    expect(fixture.generate).not.toHaveBeenCalled();
    await fixture.service.execute('student', {
      action: 'progress',
      ...studentBase(fixture.record, 5),
      sceneId: 'predict',
      intent: 'workedAnswer',
      frame: 0,
      reflection: '',
    });
    const workedNote = {
      ...note,
      noteId: randomUUID(),
      anchor: { ...note.anchor, phase: 'worked' as const },
    };
    await fixture.service.execute('student', {
      action: 'saveNote',
      ...studentBase(fixture.record, 6),
      note: workedNote,
    });
    await fixture.service.execute('student', {
      action: 'progress',
      ...studentBase(fixture.record, 7),
      sceneId: 'predict',
      intent: 'retry',
      frame: 0,
      reflection: '',
    });
    await expect(
      fixture.service.execute('student', {
        action: 'progress',
        ...studentBase(fixture.record, 8),
        sceneId: 'predict',
        intent: 'revisit',
        noteId: workedNote.noteId,
        frame: 0,
        reflection: '',
      }),
    ).rejects.toThrow();
  });

  it('reauthorizes cached projection receipts after withdrawal', async () => {
    const fixture = setup();
    const command: GuidedLessonCommand = {
      action: 'progress',
      ...studentBase(fixture.record, 0),
      sceneId: 'predict',
      intent: 'revisit',
      frame: 0,
      reflection: '',
    };
    await fixture.service.execute('student', command);
    await fixture.store.withdrawLessonReleases(fixture.record.id);
    await expect(fixture.service.execute('student', command)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('preserves old release note anchors when a revised lesson is published and withdraws all versions explicitly', async () => {
    const fixture = setup();
    const note = {
      noteId: randomUUID(),
      expectedVersion: 0,
      anchor: {
        releaseId: 'release-1',
        sceneId: 'watch',
        phase: LessonPhase.WATCH,
        frame: 2,
        traceEventId: null,
        sourceRef: null,
      },
      text: 'Keep this original lesson explanation.',
      isBookmark: true,
    };
    await fixture.service.execute('student', {
      action: 'saveNote',
      ...studentBase(fixture.record, 0),
      note,
    });
    if (!fixture.record.plan || !fixture.record.manifest) {
      throw new Error('Missing released lesson fixture.');
    }
    const plan = { ...fixture.record.plan, title: 'A revised running total lesson' };
    const revisionId = randomUUID();
    const contentHash = hashLessonValue({ input: fixture.record.input, plan });
    const manifest = {
      ...fixture.record.manifest,
      revisionId,
      contentHash,
      speechArtifacts: fixture.record.manifest.speechArtifacts.map((artifact) => ({
        ...artifact,
        contentHash,
      })),
    };
    const renderManifestHash = hashLessonValue(manifest);
    // A distinct already-reviewed revision is the precondition; the full author/render path has its own integration journey.
    const revised: LessonRecord = {
      ...fixture.record,
      version: 2,
      revisionId,
      title: plan.title,
      plan,
      contentHash,
      manifest,
      speech: manifest.speechArtifacts,
      status: LessonStatus.PREVIEW_READY,
      scriptApproval: { commandId: randomUUID(), contentHash, at: now().toISOString() },
      previewApproval: {
        commandId: randomUUID(),
        manifestHash: renderManifestHash,
        evidenceIds: manifest.evidence.map((evidence) => evidence.evidenceId),
        at: now().toISOString(),
      },
    };
    fixture.store.lessons.set(revised.id, revised);
    const released = await fixture.service.execute('teacher', {
      action: 'release',
      commandId: randomUUID(),
      classId: revised.classId,
      lessonId: revised.id,
      expectedVersion: revised.version,
      contentHash,
      renderManifestHash,
    });
    if (released.kind !== 'detail' || !released.lesson.releaseId) {
      throw new Error('Revised release missing.');
    }
    const newReleaseId = released.lesson.releaseId;
    expect(newReleaseId).not.toBe('release-1');
    expect(fixture.store.releases.get('release-1')?.available).toBe(true);
    const oldNotes = await fixture.service.read('student', {
      action: 'notes',
      classId: revised.classId,
      releaseId: 'release-1',
    });
    expect(oldNotes.kind === 'notes' && oldNotes.notes[0]?.anchor).toEqual(note.anchor);
    const oldProjection = await fixture.service.execute('student', {
      action: 'progress',
      ...studentBase(fixture.record, 1),
      sceneId: 'watch',
      intent: 'revisit',
      noteId: note.noteId,
      frame: 0,
      reflection: '',
    });
    expect(oldProjection.kind === 'projection' && oldProjection.projection.revisionId).toBe(
      fixture.record.revisionId,
    );
    expect(oldProjection.kind === 'projection' && oldProjection.projection.frame).toBe(2);
    const newProjection = await fixture.service.read('student', {
      action: 'projection',
      classId: revised.classId,
      releaseId: newReleaseId,
    });
    expect(newProjection.kind === 'projection' && newProjection.projection.revisionId).toBe(
      revisionId,
    );
    const library = await fixture.service.read('student', {
      action: 'list',
      classId: revised.classId,
    });
    expect(library.kind === 'list' && library.lessons.map((lesson) => lesson.releaseId)).toEqual([
      newReleaseId,
    ]);
    await fixture.service.execute('teacher', {
      action: 'withdraw',
      commandId: randomUUID(),
      classId: revised.classId,
      lessonId: revised.id,
      expectedVersion: released.lesson.version,
    });
    expect(fixture.store.releases.get('release-1')?.available).toBe(false);
    expect(fixture.store.releases.get(newReleaseId)?.available).toBe(false);
    for (const releaseId of ['release-1', newReleaseId]) {
      await expect(
        fixture.service.read('student', {
          action: 'projection',
          classId: revised.classId,
          releaseId,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(fixture.store.notes.get(note.noteId)?.note.anchor).toEqual(note.anchor);
  });

  it('settles a late cancelled provider result without attaching it to the cancelled draft', async () => {
    let finish: ((value: Awaited<ReturnType<LessonModel['generate']>>) => void) | undefined;
    let dispatched: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const model: LessonModel = {
      countInput: vi.fn<LessonModel['countInput']>().mockResolvedValue(100),
      generate: vi.fn<LessonModel['generate']>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
            dispatched?.();
          }),
      ),
    };
    const fixture = setup(model);
    fixture.store.lessons.set(fixture.record.id, {
      ...fixture.record,
      plan: null,
      manifest: null,
      status: 'needsTeacherInput',
      releaseId: null,
    });
    await fixture.service.execute('teacher', {
      action: 'start',
      commandId: randomUUID(),
      classId: fixture.record.classId,
      lessonId: fixture.record.id,
      expectedVersion: 1,
    });
    const generation = fixture.service.prepareNextLesson();
    await started;
    const claimed = fixture.store.lessons.get(fixture.record.id);
    if (!fixture.record.plan) {
      throw new Error('Missing lesson plan fixture.');
    }
    await expect(
      fixture.service.execute('teacher', {
        action: 'savePlan',
        commandId: randomUUID(),
        classId: fixture.record.classId,
        lessonId: fixture.record.id,
        expectedVersion: claimed?.version ?? 0,
        plan: fixture.record.plan,
      }),
    ).rejects.toMatchObject({ code: 'usageUncertain' });
    await fixture.service.execute('teacher', {
      action: 'cancel',
      commandId: randomUUID(),
      classId: fixture.record.classId,
      lessonId: fixture.record.id,
      expectedVersion: claimed?.version ?? 0,
    });
    finish?.({
      result: { status: 'ready', plan: fixture.record.plan },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    await generation;
    expect(fixture.store.lessons.get(fixture.record.id)).toMatchObject({
      status: 'cancelled',
      plan: null,
      run: { inputTokens: 100, outputTokens: 20 },
    });
    expect(
      [...fixture.store.budgets.values()]
        .flatMap((budget) => budget.reservations)
        .every((item) => item.state === 'settled'),
    ).toBe(true);
  });

  it('records known help usage before refusing a response after enrollment revocation', async () => {
    let finish: ((value: Awaited<ReturnType<LessonModel['generate']>>) => void) | undefined;
    let dispatched: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const model: LessonModel = {
      countInput: vi.fn<LessonModel['countInput']>().mockResolvedValue(100),
      generate: vi.fn<LessonModel['generate']>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
            dispatched?.();
          }),
      ),
    };
    const fixture = setup(model);
    const question = fixture.service.execute('student', {
      action: 'help',
      ...studentBase(fixture.record, 0),
      sceneId: 'watch',
      message: 'What should I notice first?',
    });
    await started;
    fixture.store.accesses.delete(`student:${fixture.record.classId}`);
    finish?.({
      result: { kind: 'insufficientContext', text: 'Read the approved source.' },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    await expect(question).rejects.toMatchObject({ code: 'forbidden' });
    expect(fixture.store.budgets.get('help:student:2026-10-09')?.reservations[0]).toMatchObject({
      state: 'settled',
      actualInput: 100,
      actualOutput: 20,
    });
  });

  it('does not automatically replay a timed-out paid generation and retains its reservation', async () => {
    const model: LessonModel = {
      countInput: vi.fn<LessonModel['countInput']>().mockResolvedValue(100),
      generate: vi
        .fn<LessonModel['generate']>()
        .mockRejectedValue(new Error('connection lost after dispatch')),
    };
    const fixture = setup(model);
    fixture.store.lessons.set(fixture.record.id, {
      ...fixture.record,
      plan: null,
      manifest: null,
      scriptApproved: false,
      status: 'needsTeacherInput',
      releaseId: null,
    });
    await fixture.service.execute('teacher', {
      action: 'start',
      commandId: randomUUID(),
      classId: fixture.record.classId,
      lessonId: fixture.record.id,
      expectedVersion: 1,
    });
    await fixture.service.prepareNextLesson();
    await fixture.service.prepareNextLesson();
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    const record = fixture.store.lessons.get(fixture.record.id);
    expect(record?.status).toBe('usageUncertain');
    expect(
      [...fixture.store.budgets.values()]
        .flatMap((budget) => budget.reservations)
        .some((item) => item.state === 'uncertain'),
    ).toBe(true);
    await expect(
      fixture.service.execute('teacher', {
        action: 'retry',
        commandId: randomUUID(),
        classId: fixture.record.classId,
        lessonId: fixture.record.id,
        expectedVersion: record?.version ?? 0,
      }),
    ).rejects.toMatchObject({ code: 'usageUncertain' });
  });

  it('charges known usage for malformed output and stops without a hidden format repair', async () => {
    const model: LessonModel = {
      countInput: vi.fn<LessonModel['countInput']>().mockResolvedValue(100),
      generate: vi.fn<LessonModel['generate']>().mockResolvedValue({
        result: { invalid: true },
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
    };
    const fixture = setup(model);
    fixture.store.lessons.set(fixture.record.id, {
      ...fixture.record,
      plan: null,
      manifest: null,
      status: 'needsTeacherInput',
      releaseId: null,
    });
    await fixture.service.execute('teacher', {
      action: 'start',
      commandId: randomUUID(),
      classId: fixture.record.classId,
      lessonId: fixture.record.id,
      expectedVersion: 1,
    });
    await fixture.service.prepareNextLesson();
    expect(fixture.store.lessons.get(fixture.record.id)).toMatchObject({
      status: 'failed',
      run: { inputTokens: 100, outputTokens: 20 },
    });
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });

  it('atomically admits only five daily runs under concurrent requests and retains unknown allowances', async () => {
    const store = new MemoryGuidedLessonStore();
    const admitted = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        store.runAtomically((transaction) => admitLessonRun(transaction, 'teacher', now())),
      ),
    );
    expect(admitted.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    const record = createStoredLesson();
    record.run = {
      id: 'run-1',
      day: '2026-10-09',
      stage: 'drafting',
      claimId: null,
      leaseUntil: null,
      dispatched: false,
      contentRepairs: 0,
      visualRepairs: 0,
      physicalAttempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      speechAttempts: 0,
      speechCharacters: 0,
      renderRetries: 0,
    };
    store.budgets.set('teacher:2026-10-09', {
      ...createLessonBudget('teacher:2026-10-09'),
      version: 1,
      reservations: [
        {
          id: 'old',
          runId: 'old-run',
          lessonId: record.id,
          stage: 'drafting',
          input: 8000,
          output: 6000,
          speechCharacters: 0,
          state: 'uncertain',
          actualInput: null,
          actualOutput: null,
        },
      ],
    });
    await expect(
      store.runAtomically((transaction) =>
        reserveLessonAttempt(transaction, record, {
          id: 'new',
          runId: 'run-1',
          lessonId: record.id,
          stage: 'drafting',
          input: 100,
          output: 6000,
          speechCharacters: 0,
          state: 'dispatched',
          actualInput: null,
          actualOutput: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'budgetBlocked' });
  });

  it('measures token usage above the old quotas without interrupting the next attempt', async () => {
    const store = new MemoryGuidedLessonStore();
    const record = createStoredLesson();
    record.run = {
      id: 'measured-run',
      day: '2026-10-09',
      stage: 'rendering',
      claimId: null,
      leaseUntil: null,
      dispatched: false,
      contentRepairs: 0,
      visualRepairs: 0,
      physicalAttempts: 0,
      inputTokens: 400000,
      outputTokens: 150000,
      speechAttempts: 0,
      speechCharacters: 0,
      renderRetries: 0,
    };
    store.budgets.set('teacher:2026-10-09', {
      ...createLessonBudget('teacher:2026-10-09'),
      version: 1,
      reservations: [
        {
          id: 'measured',
          runId: 'measured-run',
          lessonId: record.id,
          stage: 'codingVisuals',
          input: 0,
          output: 0,
          speechCharacters: 0,
          state: 'settled',
          actualInput: 400000,
          actualOutput: 150000,
        },
      ],
    });
    await store.runAtomically((transaction) =>
      reserveLessonAttempt(transaction, record, {
        id: 'next-measured',
        runId: 'measured-run',
        lessonId: record.id,
        stage: 'codingVisuals',
        input: 0,
        output: 0,
        speechCharacters: 0,
        state: 'dispatched',
        actualInput: null,
        actualOutput: null,
      }),
    );
    expect(store.budgets.get('teacher:2026-10-09')?.reservations).toHaveLength(2);
  });

  it('rejects an unavailable render sandbox before any paid content or speech call', async () => {
    const fixture = setup();
    const synthesize = vi.spyOn(fixture.speech, 'synthesize');
    fixture.renderer.checkReady = vi
      .fn<NonNullable<LessonRenderer['checkReady']>>()
      .mockRejectedValue(new LessonProviderNotDispatchedError('Sandbox unavailable.'));
    const day = await fixture.store.runAtomically((transaction) =>
      admitLessonRun(transaction, 'teacher', now()),
    );
    fixture.record.status = LessonStatus.ADMITTED;
    fixture.record.run = {
      id: 'unavailable-render-run',
      day,
      stage: LessonStatus.ADMITTED,
      claimId: null,
      leaseUntil: null,
      dispatched: false,
      contentRepairs: 0,
      visualRepairs: 0,
      physicalAttempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      speechAttempts: 0,
      speechCharacters: 0,
      renderRetries: 0,
    };
    await fixture.service.prepareNextLesson();
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(fixture.store.lessons.get(fixture.record.id)?.status).toBe(LessonStatus.FAILED);
    expect(fixture.store.budgets.get(`teacher:${day}`)?.reservations).toEqual([]);
  });

  it('settles coding-agent usage durably even when rendering fails afterwards', async () => {
    const fixture = setup();
    const render = vi.spyOn(fixture.renderer, 'render');
    render.mockImplementation(async (_request, _signal, lifecycle) => {
      if (!lifecycle) {
        throw new Error('No coding-agent accounting lifecycle.');
      }
      await lifecycle.beforeModelCall('coding-request');
      await lifecycle.afterModelCall('coding-request', { inputTokens: 15000, outputTokens: 2000 });
      throw new Error('Synthetic encoding failure after provider response.');
    });
    const day = await fixture.store.runAtomically((transaction) =>
      admitLessonRun(transaction, 'teacher', now()),
    );
    fixture.record.status = LessonStatus.RENDERING;
    fixture.record.speech = [];
    fixture.record.run = {
      id: 'render-run',
      day,
      stage: LessonStatus.RENDERING,
      claimId: null,
      leaseUntil: null,
      dispatched: false,
      contentRepairs: 0,
      visualRepairs: 0,
      physicalAttempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      speechAttempts: 0,
      speechCharacters: 0,
      renderRetries: 0,
    };
    await fixture.service.prepareNextLesson();
    expect(fixture.store.lessons.get(fixture.record.id)).toMatchObject({
      status: LessonStatus.FAILED,
      run: { inputTokens: 15000, outputTokens: 2000, graphicsAttempts: 1, dispatched: false },
    });
    expect(fixture.store.budgets.get(`teacher:${day}`)?.reservations[0]).toMatchObject({
      state: 'settled',
      actualInput: 15000,
      actualOutput: 2000,
    });
  });

  it('hashes bounded JSON independently of object insertion order', () => {
    expect(hashLessonValue({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashLessonValue({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });
});
