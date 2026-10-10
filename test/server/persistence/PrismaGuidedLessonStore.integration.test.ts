import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { AccountRole } from '#contracts/AccountRole.js';
import { LessonPhase } from '#contracts/GuidedLessons.js';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { createPrismaGuidedLessonStore } from '../../../src/server/persistence/PrismaGuidedLessonStore.js';
import { admitLessonRun } from '../../../src/server/features/guidedLessons/application/LessonBudget.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';
import { createStoredLesson } from '../features/guidedLessons/StoredLessonFixture.js';

const environment = readServerEnv(process.env);
const classroom = createPrismaClassroomStore(environment.DATABASE_URL);
const database = createPrismaGuidedLessonStore(environment.DATABASE_URL);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});

afterAll(async () => {
  await database.close();
  await classroom.close();
  await client.$disconnect();
});

async function createFixture() {
  const teacher = randomUUID();
  const student = randomUUID();
  const other = randomUUID();
  await client.user.createMany({
    data: [teacher, student, other].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      role: id === teacher ? AccountRole.TEACHER : AccountRole.STUDENT,
    })),
  });
  const course = await classroom.store.saveCourse(
    teacher,
    'Guided lesson integration',
    createCourseContent(),
  );
  const schoolClass = await classroom.store.saveClass(teacher, 'Home study', course.id);
  await client.classroomEnrollment.create({
    data: { classId: schoolClass.id, studentId: student },
  });
  const original = createStoredLesson();
  const releaseId = randomUUID();
  const record = {
    ...original,
    teacherId: teacher,
    classId: schoolClass.id,
    revisionId: randomUUID(),
    releaseId,
    input: { ...original.input, classId: schoolClass.id, courseRevisionId: course.id },
  };
  await database.store.runAtomically(async (store) => {
    await store.saveLesson(record, 0);
    await store.saveRevision(record);
    await store.saveRelease({
      id: releaseId,
      lessonId: record.id,
      classId: record.classId,
      available: true,
      releasedAt: '2026-10-09T12:00:00.000Z',
      record,
    });
  });
  return { teacher, student, other, record, releaseId, schoolClass };
}

describe('guided lesson PostgreSQL isolation and durable persistence', () => {
  it('uses enrollment independently of live sessions and reads revocation on the next transaction', async () => {
    const fixture = await createFixture();
    expect(
      await database.store.runAtomically((store) =>
        store.readAccess(fixture.student, fixture.schoolClass.id),
      ),
    ).toMatchObject({ enrolled: true, isTeacher: false });
    expect(await database.store.readAccess(fixture.other, fixture.schoolClass.id)).toMatchObject({
      enrolled: false,
      isTeacher: false,
    });
    await client.classroomEnrollment.update({
      where: { classId_studentId: { classId: fixture.schoolClass.id, studentId: fixture.student } },
      data: { active: false },
    });
    expect(
      await database.store.runAtomically((store) =>
        store.readAccess(fixture.student, fixture.schoolClass.id),
      ),
    ).toMatchObject({ enrolled: false });
    expect(
      await client.classroomMeeting.count({ where: { classId: fixture.schoolClass.id } }),
    ).toBe(0);
  });

  it('fences concurrent draft versions and retains immutable release content', async () => {
    const fixture = await createFixture();
    const results = await Promise.allSettled(
      ['First edit', 'Second edit'].map((title) =>
        database.store.runAtomically((store) =>
          store.saveLesson({ ...fixture.record, title, version: 2 }, 1),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await database.store.readLesson(fixture.record.id))?.version).toBe(2);
    const released = await database.store.readRelease(fixture.releaseId);
    if (!released) {
      throw new Error('Missing released snapshot.');
    }
    await database.store.runAtomically((store) =>
      store.saveRelease({
        ...released,
        record: { ...released.record, title: 'Cannot overwrite this frozen snapshot' },
      }),
    );
    expect((await database.store.readRelease(fixture.releaseId))?.record.title).toBe(
      fixture.record.title,
    );
    await database.store.runAtomically((store) => store.withdrawLessonReleases(fixture.record.id));
    expect((await database.store.readRelease(fixture.releaseId))?.available).toBe(false);
  });

  it('keeps note ownership and rolls back a rejected cross-student write with its budget mutation', async () => {
    const fixture = await createFixture();
    const note = {
      noteId: randomUUID(),
      expectedVersion: 0,
      anchor: {
        releaseId: fixture.releaseId,
        sceneId: 'watch',
        phase: LessonPhase.WATCH,
        frame: 0,
        traceEventId: null,
        sourceRef: null,
      },
      text: 'Only my note',
      isBookmark: false,
    };
    await database.store.runAtomically((store) =>
      store.saveNote(fixture.student, fixture.schoolClass.id, note),
    );
    expect(await database.store.listNotes(fixture.other, fixture.releaseId)).toEqual([]);
    await expect(
      database.store.runAtomically(async (store) => {
        await admitLessonRun(store, fixture.teacher, new Date('2026-10-09T12:00:00Z'));
        await store.saveNote(fixture.other, fixture.schoolClass.id, {
          ...note,
          expectedVersion: 1,
          text: 'Overwrite attempt',
        });
      }),
    ).rejects.toMatchObject({ code: 'versionConflict' });
    expect(await database.store.readBudget(`${fixture.teacher}:2026-10-09`)).toBeNull();
    expect((await database.store.listNotes(fixture.student, fixture.releaseId))[0]?.text).toBe(
      'Only my note',
    );
  });

  it('admits the fifth daily run once when two transactions compete', async () => {
    const fixture = await createFixture();
    const now = new Date('2026-10-09T12:00:00Z');
    for (let index = 0; index < 4; index += 1) {
      await database.store.runAtomically((store) => admitLessonRun(store, fixture.teacher, now));
    }
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        database.store.runAtomically((store) => admitLessonRun(store, fixture.teacher, now)),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await database.store.readBudget(`${fixture.teacher}:2026-10-09`))?.runs).toBe(5);
  });
});
