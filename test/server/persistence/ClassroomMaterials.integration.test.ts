import { PrepareMaterialCollection } from '../../../src/server/features/materials/application/PrepareMaterialCollection.js';
import {
  createMaterialGeneration,
  readCompactCollection,
} from '../features/materials/CompactMaterialFixtures.js';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { MaterialService } from '../../../src/server/features/materials/application/MaterialService.js';
import { MaterialExtractorWorker } from '../../../src/server/features/materials/infrastructure/MaterialExtractorWorker.js';
import { registerMaterialRoutes } from '../../../src/server/features/materials/infrastructure/RegisterMaterialRoutes.js';
import { ClassroomService } from '../../../src/server/features/classroom/application/ClassroomService.js';
import { createApi } from '../../../src/server/CreateApi.js';
import { createServerLogger } from '../../../src/server/Logger.js';
import { fakeMaterialPreparation } from '../features/materials/MaterialFixtures.js';
import { MaterialReplySchema, type MaterialCommand } from '#contracts/ClassroomMaterials.js';
import { AccountRole } from '#contracts/AccountRole.js';

const environment = readServerEnv(process.env);
const database = createPrismaClassroomStore(environment.DATABASE_URL);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});
afterAll(async () => {
  await database.close();
  await client.$disconnect();
});

describe('materials PostgreSQL and authenticated HTTP', () => {
  it('persists original bytes, serializes versions, publishes review and limits student downloads', async () => {
    const teacher = randomUUID();
    const student = randomUUID();
    await client.user.createMany({
      data: [
        {
          id: teacher,
          name: 'Teacher',
          email: `${teacher}@example.test`,
          emailVerified: true,
          role: AccountRole.TEACHER,
        },
        {
          id: student,
          name: 'Student',
          email: `${student}@example.test`,
          emailVerified: true,
          role: AccountRole.STUDENT,
        },
      ],
    });
    await new ClassroomService(database.store).execute(teacher, {
      kind: 'create-class',
      name: 'Materials class',
    });
    const schoolClass = (await database.store.listClasses(teacher))[0];
    if (!schoolClass) {
      throw new Error('Class missing.');
    }
    const service = new MaterialService(
      database.store,
      new MaterialExtractorWorker(),
      fakeMaterialPreparation,
    );
    const api = createApi({ isDatabaseReady: () => Promise.resolve(true) });
    registerMaterialRoutes(
      api,
      (headers) =>
        Promise.resolve(
          headers['x-test-user'] === teacher
            ? teacher
            : headers['x-test-user'] === student
              ? student
              : null,
        ),
      service,
      createServerLogger(environment.APP_ENV),
    );

    async function send(userId: string, command: MaterialCommand) {
      const result = await api.inject({
        method: 'POST',
        url: '/api/v1/classroom/materials',
        headers: { 'x-test-user': userId },
        payload: command,
      });
      const raw: unknown = result.json();
      return MaterialReplySchema.parse(raw);
    }

    try {
      const command: MaterialCommand = {
        kind: 'upload',
        classId: schoolClass.id,
        version: 0,
        name: 'Example.py',
        data: Buffer.from('print("Hello")').toString('base64'),
      };
      const uploads = await Promise.all([send(teacher, command), send(teacher, command)]);
      expect(uploads.filter((reply) => reply.kind === 'collection')).toHaveLength(1);
      expect(uploads.filter((reply) => reply.kind === 'failed')).toHaveLength(1);
      const uploaded = uploads.find((reply) => reply.kind === 'collection');
      if (uploaded?.kind !== 'collection') {
        throw new Error('Upload missing.');
      }
      const id = uploaded.collection.sources[0]?.id;
      if (!id) {
        throw new Error('Source missing.');
      }
      await database.store.enrollStudent(schoolClass.id, student, true);
      expect(
        await send(student, { kind: 'download', classId: schoolClass.id, materialId: id }),
      ).toMatchObject({ kind: 'failed', code: 'forbidden' });
      await send(teacher, {
        kind: 'prepare',
        classId: schoolClass.id,
        version: uploaded.collection.version,
        teacherInstructions: '',
        locale: 'en',
      });
      await service.prepareNextCollection();
      const review = await send(teacher, { kind: 'read', classId: schoolClass.id });
      if (review.kind !== 'collection' || !review.collection.draft) {
        throw new Error('Review missing.');
      }
      const draft = review.collection.draft;
      const saved = await send(teacher, {
        kind: 'save-review',
        classId: schoolClass.id,
        version: review.collection.version,
        teacherInstructions: 'Start with the existing project.',
        summary: draft.summary,
        sections: draft.sections,
        notes: draft.pages.map((page) => ({ pageId: page.id, text: 'Teacher correction' })),
        resolvedQuestions: true,
      });
      if (saved.kind !== 'collection') {
        throw new Error('Save failed.');
      }
      const approved = await send(teacher, {
        kind: 'approve',
        classId: schoolClass.id,
        version: saved.collection.version,
      });
      expect(approved).toMatchObject({ kind: 'collection', collection: { state: 'approved' } });
      const current = await database.store.readClass(schoolClass.id);
      const publication = current
        ? await database.store.readMaterialPublication(current.courseRevisionId)
        : null;
      expect(publication?.draft.pages[0]?.teacherNote).toBe('Teacher correction');
      const download = await send(student, {
        kind: 'download',
        classId: schoolClass.id,
        materialId: id,
      });
      expect(download).toMatchObject({ kind: 'download', data: command.data });
      const removed = await send(teacher, {
        kind: 'remove',
        classId: schoolClass.id,
        materialId: id,
        version: approved.kind === 'collection' ? approved.collection.version : -1,
      });
      expect(removed).toMatchObject({
        kind: 'collection',
        collection: { sources: [], state: 'collecting' },
      });
      // JSON publication references keep originals usable for already-approved lessons.
      expect(await database.store.readMaterialFile(id)).not.toBeNull();
      expect(
        await send(student, { kind: 'download', classId: schoolClass.id, materialId: id }),
      ).toMatchObject({ kind: 'download' });
      const unusedClass = await database.store.saveClass(
        teacher,
        'Unused materials',
        schoolClass.courseRevisionId,
      );
      const unusedUpload = await send(teacher, { ...command, classId: unusedClass.id });
      if (unusedUpload.kind !== 'collection' || !unusedUpload.collection.sources[0]) {
        throw new Error('Unused source missing.');
      }
      const unusedId = unusedUpload.collection.sources[0].id;
      expect(
        await send(teacher, {
          kind: 'remove',
          classId: unusedClass.id,
          materialId: unusedId,
          version: unusedUpload.collection.version,
        }),
      ).toMatchObject({ kind: 'collection' });
      expect(await database.store.readMaterialFile(unusedId)).toBeNull();
      expect(await database.store.readMaterialStorageBytes(unusedClass.id)).toBe(0);
      await database.store.enrollStudent(schoolClass.id, student, false);
      expect(
        await send(student, { kind: 'download', classId: schoolClass.id, materialId: id }),
      ).toMatchObject({ kind: 'failed', code: 'forbidden' });
      await database.store.runAtomically(async (store) => {
        for (let count = 0; count < 9; count += 1) {
          await store.reserveMaterialPreparation(teacher, new Date().toISOString().slice(0, 10));
        }
      });
      // The preparation already consumed today's reservation.
      await expect(
        database.store.runAtomically((store) =>
          store.reserveMaterialPreparation(teacher, new Date().toISOString().slice(0, 10)),
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await api.close();
    }
  }, 40_000);
});

it('persists compact stages with claim fencing and reuses briefs across preparation jobs', async () => {
  const teacher = randomUUID();
  await client.user.create({
    data: {
      id: teacher,
      name: 'Teacher',
      email: `${teacher}@example.test`,
      emailVerified: true,
      role: AccountRole.TEACHER,
    },
  });
  const classroom = new ClassroomService(database.store);
  await classroom.execute(teacher, { kind: 'create-class', name: 'Compact Python' });
  const schoolClass = (await database.store.listClasses(teacher))[0];
  if (!schoolClass) {
    throw new Error('Class missing.');
  }
  const generation = createMaterialGeneration();
  const service = new MaterialService(
    database.store,
    new MaterialExtractorWorker(),
    new PrepareMaterialCollection(database.store, generation),
  );
  let collection = readCompactCollection(
    await service.execute(teacher, {
      kind: 'upload',
      classId: schoolClass.id,
      version: 0,
      materialSchemaVersion: 2,
      name: 'Lesson.py',
      data: Buffer.from('print("Hello")').toString('base64'),
    }),
  );
  const queue = async (teacherInstructions: string) =>
    service.execute(teacher, {
      kind: 'prepare',
      classId: schoolClass.id,
      version: collection.version,
      materialSchemaVersion: 2,
      locale: 'en',
      teacherInstructions,
    });
  await queue('Teach Python.');
  await service.prepareNextCollection();
  collection = readCompactCollection(
    await service.execute(teacher, {
      kind: 'read',
      classId: schoolClass.id,
      materialSchemaVersion: 2,
    }),
  );
  expect(collection.draft).toHaveProperty('schemaVersion', 2);
  expect(generation.generate).toHaveBeenCalledTimes(2);
  const stored = await database.store.readMaterialCollection(schoolClass.id);
  const stages = await database.store.listMaterialDerivations(stored?.jobId ?? '');
  expect(stages).toHaveLength(2);
  const stage = stages[0];
  if (!stage) {
    throw new Error('Stage missing.');
  }
  await expect(database.store.saveMaterialDerivation(stage, randomUUID())).rejects.toMatchObject({
    code: 'stale',
  });
  await queue('Practice independently.');
  await service.prepareNextCollection();
  expect(generation.generate).toHaveBeenCalledTimes(3);
  const freshStore = createPrismaClassroomStore(environment.DATABASE_URL);
  try {
    expect(await freshStore.store.readMaterialDerivation(schoolClass.id, stage.key)).toMatchObject({
      state: 'completed',
      result: stage.result,
    });
    const latest = readCompactCollection(
      await service.execute(teacher, {
        kind: 'read',
        classId: schoolClass.id,
        materialSchemaVersion: 2,
      }),
    );
    const queued = readCompactCollection(
      await service.execute(teacher, {
        kind: 'prepare',
        classId: schoolClass.id,
        version: latest.version,
        materialSchemaVersion: 2,
        locale: 'en',
        teacherInstructions: 'Practice independently.',
        revisionRequest: 'Combine the first two sections.',
      }),
    );
    expect(queued.sources).toEqual(latest.sources);
    expect(queued.draft).toEqual(latest.draft);
    expect(await freshStore.store.readMaterialCollection(schoolClass.id)).toMatchObject({
      revisionRequest: 'Combine the first two sections.',
    });
    const resumed = new MaterialService(
      freshStore.store,
      new MaterialExtractorWorker(),
      new PrepareMaterialCollection(freshStore.store, generation),
    );
    await resumed.prepareNextCollection();
    expect(generation.generate).toHaveBeenCalledTimes(4);
    expect(generation.generate.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'composition',
      revision: {
        request: 'Combine the first two sections.',
        previousSummary: latest.draft?.summary,
      },
    });
    expect(await freshStore.store.readMaterialCollection(schoolClass.id)).toMatchObject({
      state: 'review',
      revisionRequest: null,
    });
  } finally {
    await freshStore.close();
  }
});
