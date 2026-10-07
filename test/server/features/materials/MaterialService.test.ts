import { createPracticeCheckpoint } from '../classroom/PracticeFixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ClassroomService } from '../../../../src/server/features/classroom/application/ClassroomService.js';
import { MaterialService } from '../../../../src/server/features/materials/application/MaterialService.js';
import { ExtractMaterial } from '../../../../src/server/features/materials/infrastructure/ExtractMaterial.js';
import {
  MaterialState,
  type MaterialCollection,
  type MaterialReply,
} from '#contracts/ClassroomMaterials.js';
import { ClassroomPacing } from '#contracts/Classroom.js';
import { MemoryClassroomStore } from '../classroom/ClassroomFixtures.js';
import { fakeMaterialPreparation } from './MaterialFixtures.js';
import {
  MaterialPreparationError,
  MaterialPreparationReason,
} from '../../../../src/server/features/materials/application/MaterialPreparationError.js';

function readCollection(reply: MaterialReply): MaterialCollection {
  if (reply.kind !== 'collection') {
    throw new Error('Collection missing.');
  }
  return reply.collection;
}

async function setup() {
  const store = new MemoryClassroomStore();
  const classroom = new ClassroomService(store);
  await classroom.execute('teacher', { kind: 'create-class', name: 'Scratch' });
  const schoolClass = [...store.classes.values()][0];
  if (!schoolClass) {
    throw new Error('Class missing.');
  }
  const prepare = vi.fn((input: Parameters<typeof fakeMaterialPreparation.prepare>[0]) =>
    fakeMaterialPreparation.prepare(input),
  );
  const extractor = new ExtractMaterial();
  const extract = vi.fn(extractor.extract.bind(extractor));
  const reportFailure = vi.fn<NonNullable<ConstructorParameters<typeof MaterialService>[4]>>();
  const service = new MaterialService(
    store,
    { extract },
    { available: true, prepare },
    undefined,
    reportFailure,
  );
  const uploaded = readCollection(
    await service.execute('teacher', {
      kind: 'upload',
      classId: schoolClass.id,
      version: 0,
      name: 'Lesson.py',
      data: Buffer.from('print("Hello")\n# Setup: connect start event.').toString('base64'),
    }),
  );
  return {
    store,
    classroom,
    service,
    uploaded,
    prepare,
    extract,
    reportFailure,
    classId: schoolClass.id,
  };
}

async function prepareFixture() {
  const fixture = await setup();
  await fixture.service.execute('teacher', {
    kind: 'prepare',
    classId: fixture.classId,
    version: fixture.uploaded.version,
    locale: 'en',
    teacherInstructions: 'Explain; students do the work.',
  });
  expect(fixture.prepare).not.toHaveBeenCalled();
  await fixture.service.prepareNextCollection();
  const review = readCollection(
    await fixture.service.execute('teacher', { kind: 'read', classId: fixture.classId }),
  );
  if (!review.draft) {
    throw new Error('Draft missing.');
  }
  const saved = readCollection(
    await fixture.service.execute('teacher', {
      kind: 'save-review',
      classId: fixture.classId,
      version: review.version,
      teacherInstructions: review.teacherInstructions,
      summary: review.draft.summary,
      sections: review.draft.sections,
      notes: review.draft.pages.map((page) => ({
        pageId: page.id,
        text: 'Teacher: attach a green flag trigger before running.',
      })),
      resolvedQuestions: true,
    }),
  );
  return { ...fixture, review, saved };
}

describe('materials-first classroom workflow', () => {
  it('denies material access and stops queued preparation after class deletion', async () => {
    const { service, classroom, uploaded, classId, prepare } = await setup();
    await service.execute('teacher', {
      kind: 'prepare',
      classId,
      version: uploaded.version,
      locale: 'en',
      teacherInstructions: '',
    });
    await classroom.execute('teacher', { kind: 'delete-class', classId });
    await expect(service.execute('teacher', { kind: 'read', classId })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await service.prepareNextCollection()).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('removes unused files atomically and rejects unauthorized or stale removals', async () => {
    const { service, uploaded, store, classId } = await setup();
    const materialId = uploaded.sources[0]?.id;
    if (!materialId) {
      throw new Error('Material missing.');
    }
    const command = { kind: 'remove', classId, version: uploaded.version, materialId } as const;
    await expect(service.execute('student', command)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.execute('teacher', { ...command, version: 0 })).rejects.toMatchObject({
      code: 'stale',
    });
    expect(await store.readMaterialFile(materialId)).not.toBeNull();
    const removed = readCollection(await service.execute('teacher', command));
    expect(removed.sources).toEqual([]);
    expect(removed.state).toBe(MaterialState.COLLECTING);
    expect(await store.readMaterialFile(materialId)).toBeNull();
    expect(await store.readMaterialStorageBytes(classId)).toBe(0);
  });

  it('retains approved originals when a material is removed from the next preparation', async () => {
    const { service, saved, store, classId } = await prepareFixture();
    const approved = readCollection(
      await service.execute('teacher', { kind: 'approve', classId, version: saved.version }),
    );
    const materialId = approved.sources[0]?.id;
    if (!materialId || !approved.approvedCourseId) {
      throw new Error('Publication missing.');
    }
    const removed = readCollection(
      await service.execute('teacher', {
        kind: 'remove',
        classId,
        version: approved.version,
        materialId,
      }),
    );
    expect(removed.sources).toEqual([]);
    expect(await store.readMaterialFile(materialId)).not.toBeNull();
    expect((await store.readMaterialPublication(approved.approvedCourseId))?.sources[0]?.id).toBe(
      materialId,
    );
    await store.enrollStudent(classId, 'student', true);
    expect(
      await service.execute('student', { kind: 'download', classId, materialId }),
    ).toMatchObject({ kind: 'download' });
  });

  it('batches, preserves extraction and teacher edits, and publishes source context for a joined student', async () => {
    const fixture = await prepareFixture();
    const approved = readCollection(
      await fixture.service.execute('teacher', {
        kind: 'approve',
        classId: fixture.classId,
        version: fixture.saved.version,
      }),
    );
    expect(approved.state).toBe(MaterialState.APPROVED);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(approved.draft?.pages[0]?.extractedText).toContain('print("Hello")');
    expect(approved.draft?.pages[0]?.teacherNote).toContain('green flag');
    const activityId = approved.draft?.sections[0]?.id;
    if (!activityId) {
      throw new Error('Section missing.');
    }
    await fixture.store.enrollStudent(fixture.classId, 'student', true);
    await fixture.classroom.execute('teacher', {
      kind: 'start-session',
      classId: fixture.classId,
      activityId,
      pacing: ClassroomPacing.TEACHER,
    });
    const meeting = [...fixture.store.meetings.values()][0];
    if (!meeting) {
      throw new Error('Meeting missing.');
    }
    const joined = await fixture.classroom.execute('student', {
      kind: 'join',
      classSessionId: meeting.id,
      deviceId: randomUUID(),
    });
    if (joined.kind !== 'context') {
      throw new Error('Context missing.');
    }
    expect(joined.context.materialContext?.pages[0]?.teacherNote).toContain('green flag');
    const pageId = approved.draft?.pages[0]?.id;
    if (!pageId) {
      throw new Error('Page missing.');
    }
    expect(
      (
        await fixture.classroom.execute('student', {
          kind: 'read-material-notes',
          participationId: joined.context.participation.id,
          deviceId: joined.context.participation.deviceId,
          activityId,
          pageId,
        })
      ).kind,
    ).toBe('material-note');
    const sourceId = approved.sources[0]?.id;
    if (!sourceId) {
      throw new Error('Source missing.');
    }
    const download = await fixture.service.execute('student', {
      kind: 'download',
      classId: fixture.classId,
      materialId: sourceId,
    });
    expect(download.kind).toBe('download');
    await fixture.store.enrollStudent(fixture.classId, 'student', false);
    await expect(
      fixture.service.execute('student', {
        kind: 'download',
        classId: fixture.classId,
        materialId: sourceId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      fixture.classroom.execute('student', {
        kind: 'read-material-notes',
        participationId: joined.context.participation.id,
        deviceId: joined.context.participation.deviceId,
        activityId,
        pageId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('rejects student changes, unpublished downloads, stale reviews and unacknowledged approval', async () => {
    const fixture = await prepareFixture();
    const sourceId = fixture.uploaded.sources[0]?.id;
    if (!sourceId) {
      throw new Error('Source missing.');
    }
    await fixture.store.enrollStudent(fixture.classId, 'student', true);
    await expect(
      fixture.service.execute('student', { kind: 'read', classId: fixture.classId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      fixture.service.execute('student', {
        kind: 'download',
        classId: fixture.classId,
        materialId: sourceId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      fixture.service.execute('teacher', {
        kind: 'approve',
        classId: fixture.classId,
        version: fixture.review.version,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    const other = await setup();
    await expect(
      fixture.service.execute('teacher', {
        kind: 'download',
        classId: fixture.classId,
        materialId: other.uploaded.sources[0]?.id ?? randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('keeps the published course unchanged while editing and blocks approval during a live session', async () => {
    const fixture = await prepareFixture();
    const approved = readCollection(
      await fixture.service.execute('teacher', {
        kind: 'approve',
        classId: fixture.classId,
        version: fixture.saved.version,
      }),
    );
    const id = approved.draft?.sections[0]?.id;
    if (!id || !approved.draft) {
      throw new Error('Section missing.');
    }
    await fixture.classroom.execute('teacher', {
      kind: 'start-session',
      classId: fixture.classId,
      activityId: id,
      pacing: ClassroomPacing.TEACHER,
    });
    const edited = readCollection(
      await fixture.service.execute('teacher', {
        kind: 'save-review',
        classId: fixture.classId,
        version: approved.version,
        teacherInstructions: 'New teaching direction',
        summary: 'Revised summary',
        sections: approved.draft.sections,
        notes: approved.draft.pages.map((page) => ({ pageId: page.id, text: null })),
        resolvedQuestions: true,
      }),
    );
    await expect(
      fixture.service.execute('teacher', {
        kind: 'approve',
        classId: fixture.classId,
        version: edited.version,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    expect(
      (await fixture.store.readMaterialPublication(approved.approvedCourseId ?? ''))
        ?.teacherInstructions,
    ).toBe('Explain; students do the work.');
  });
  it('retains parsed pages on synthesis failure, caches them on retry and does not repeat a crashed provider call automatically', async () => {
    const fixture = await setup();
    fixture.prepare.mockRejectedValueOnce(new Error('Provider failure'));
    await fixture.service.execute('teacher', {
      kind: 'prepare',
      classId: fixture.classId,
      version: fixture.uploaded.version,
      locale: 'en',
      teacherInstructions: '',
    });
    await fixture.service.prepareNextCollection();
    const failed = readCollection(
      await fixture.service.execute('teacher', { kind: 'read', classId: fixture.classId }),
    );
    expect(failed.state).toBe('failed');
    expect(fixture.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'prepare_notes',
        reason: MaterialPreparationReason.UNKNOWN,
        sourceCount: 1,
        pageCount: 1,
      }),
    );
    expect(JSON.stringify(fixture.reportFailure.mock.calls)).not.toContain('Provider failure');
    expect(
      (await fixture.store.readMaterialCollection(fixture.classId))?.extractedPages,
    ).toHaveLength(1);
    await fixture.service.execute('teacher', {
      kind: 'prepare',
      classId: fixture.classId,
      version: failed.version,
      locale: 'en',
      teacherInstructions: '',
    });
    await fixture.service.prepareNextCollection();
    expect(fixture.extract).toHaveBeenCalledTimes(1);
    const completed = await fixture.store.readMaterialCollection(fixture.classId);
    if (!completed) {
      throw new Error('Collection missing.');
    }
    await fixture.store.saveMaterialCollection(
      {
        ...completed,
        version: completed.version + 1,
        state: 'preparing',
        leaseUntil: new Date(0).toISOString(),
      },
      completed.version,
    );
    await fixture.service.prepareNextCollection();
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect((await fixture.store.readMaterialCollection(fixture.classId))?.state).toBe('failed');
  });
  it('rejects invented source pages and keeps teacher review mandatory', async () => {
    const fixture = await setup();
    fixture.prepare.mockImplementationOnce(async (input) => {
      const draft = await fakeMaterialPreparation.prepare(input);
      return { ...draft, pages: draft.pages.map((page) => ({ ...page, id: randomUUID() })) };
    });
    await fixture.service.execute('teacher', {
      kind: 'prepare',
      classId: fixture.classId,
      version: fixture.uploaded.version,
      locale: 'en',
      teacherInstructions: '',
    });
    await fixture.service.prepareNextCollection();
    expect((await fixture.store.readMaterialCollection(fixture.classId))?.state).toBe('failed');
    const other = await setup();
    await other.service.execute('teacher', {
      kind: 'prepare',
      classId: other.classId,
      version: other.uploaded.version,
      locale: 'en',
      teacherInstructions: '',
    });
    await other.service.prepareNextCollection();
    const review = readCollection(
      await other.service.execute('teacher', { kind: 'read', classId: other.classId }),
    );
    expect(
      await other.service.execute('teacher', {
        kind: 'approve',
        classId: other.classId,
        version: review.version,
      }),
    ).toMatchObject({ kind: 'failed', issue: 'review_required' });
  });
});

it('reports safe provider diagnostics while retaining the original and extracted pages', async () => {
  const fixture = await setup();
  fixture.prepare.mockRejectedValueOnce(
    new MaterialPreparationError({
      reason: MaterialPreparationReason.INCOMPLETE_RESPONSE,
      responseStatus: 'incomplete',
    }),
  );
  await fixture.service.execute('teacher', {
    kind: 'prepare',
    classId: fixture.classId,
    version: fixture.uploaded.version,
    locale: 'en',
    teacherInstructions: '',
  });
  await fixture.service.prepareNextCollection();
  expect(fixture.reportFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      classId: fixture.classId,
      stage: 'prepare_notes',
      errorType: 'MaterialPreparationError',
      sourceCount: 1,
      pageCount: 1,
      reason: MaterialPreparationReason.INCOMPLETE_RESPONSE,
      responseStatus: 'incomplete',
    }),
  );
  expect(typeof fixture.reportFailure.mock.calls[0]?.[0].durationMs).toBe('number');
  const source = fixture.uploaded.sources[0];
  if (!source) {
    throw new Error('Missing source.');
  }
  expect(await fixture.store.readMaterialFile(source.id)).not.toBeNull();
  expect(
    (await fixture.store.readMaterialCollection(fixture.classId))?.extractedPages,
  ).toHaveLength(1);
});

it('preserves teacher page corrections when preparing the same materials again', async () => {
  const fixture = await prepareFixture();
  await fixture.service.execute('teacher', {
    kind: 'prepare',
    classId: fixture.classId,
    version: fixture.saved.version,
    locale: 'vi',
    teacherInstructions: 'Thực hành sau khi giải thích.',
  });
  await fixture.service.prepareNextCollection();
  const review = readCollection(
    await fixture.service.execute('teacher', { kind: 'read', classId: fixture.classId }),
  );
  expect(review.draft?.pages[0]?.teacherNote).toContain('green flag');
  expect(fixture.extract).toHaveBeenCalledTimes(1);
  expect(fixture.prepare).toHaveBeenLastCalledWith(
    expect.objectContaining({ locale: 'vi', teacherInstructions: 'Thực hành sau khi giải thích.' }),
  );
});

it('publishes only the teacher-reviewed checkpoint state with a fresh frozen rubric revision', async () => {
  const { service, store, classId, saved } = await prepareFixture();
  if (!saved.draft) {
    throw new Error('Missing draft.');
  }
  const checkpoint = createPracticeCheckpoint();
  const review = readCollection(
    await service.execute('teacher', {
      kind: 'save-review',
      classId,
      version: saved.version,
      teacherInstructions: saved.teacherInstructions,
      summary: saved.draft.summary,
      sections: saved.draft.sections.map((section, index) =>
        index === 0 ? { ...section, practiceCheckpoints: [checkpoint] } : section,
      ),
      notes: saved.draft.pages.map((page) => ({ pageId: page.id, text: page.teacherNote })),
      resolvedQuestions: true,
    }),
  );
  const approved = readCollection(
    await service.execute('teacher', { kind: 'approve', classId, version: review.version }),
  );
  const course = approved.approvedCourseId
    ? await store.readCourse(approved.approvedCourseId)
    : null;
  const published = course?.content.modules[0]?.lessons[0]?.activities[0]?.practiceCheckpoints?.[0];
  expect(published).toMatchObject({
    id: checkpoint.id,
    approved: true,
    criteria: checkpoint.criteria,
  });
  expect(published?.rubricRevisionId).not.toBe(checkpoint.rubricRevisionId);
});
