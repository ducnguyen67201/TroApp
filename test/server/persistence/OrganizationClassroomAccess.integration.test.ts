import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { AccountRole } from '#contracts/AccountRole.js';
import { OrganizationAction, OrganizationFailure } from '#contracts/Organizations.js';
import { OrganizationService } from '../../../src/server/features/organizations/application/OrganizationService.js';
import { createPrismaOrganizationStore } from '../../../src/server/persistence/PrismaOrganizationStore.js';
import { PetId } from '#contracts/Pet.js';
import { ClassroomPacing, ClassroomFailure } from '#contracts/Classroom.js';
import { PetWorldCommandKind, PetWorldFailure } from '#contracts/PetWorld.js';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { createPrismaClassroomStore } from '../../../src/server/persistence/PrismaClassroomStore.js';
import { createPrismaPracticeCheckStore } from '../../../src/server/persistence/PrismaPracticeCheckStore.js';
import { createPrismaClassroomInsightStore } from '../../../src/server/persistence/PrismaClassroomInsightStore.js';
import { createPrismaPetWorldStore } from '../../../src/server/persistence/PrismaPetWorldStore.js';
import { ClassroomService } from '../../../src/server/features/classroom/application/ClassroomService.js';
import { ClassroomLessonSources } from '../../../src/server/features/lessonVideos/infrastructure/ClassroomLessonSources.js';
import { PetWorldService } from '../../../src/server/features/petWorld/application/PetWorldService.js';
import { MaterialService } from '../../../src/server/features/materials/application/MaterialService.js';
import { createCourseContent } from '../features/classroom/ClassroomFixtures.js';

const environment = readServerEnv(process.env);
const classrooms = createPrismaClassroomStore(environment.DATABASE_URL);
const practice = createPrismaPracticeCheckStore(environment.DATABASE_URL);
const insights = createPrismaClassroomInsightStore(environment.DATABASE_URL);
const pets = createPrismaPetWorldStore(environment.DATABASE_URL);
const organizations = createPrismaOrganizationStore(environment.DATABASE_URL);
const organizationService = new OrganizationService(organizations.store);
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
});

afterAll(async () => {
  await Promise.all([
    classrooms.close(),
    organizations.close(),
    practice.close(),
    insights.close(),
    pets.close(),
    client.$disconnect(),
  ]);
});

async function createOrganizationClassroom() {
  const teacherId = randomUUID();
  const studentId = randomUUID();
  const ownerId = randomUUID();
  const outsideId = randomUUID();
  const organizationId = randomUUID();
  await client.user.createMany({
    data: [teacherId, studentId, ownerId, outsideId].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      /* Opposite global roles prove that scoped authority comes from membership. */
      role: id === teacherId ? AccountRole.STUDENT : AccountRole.TEACHER,
    })),
  });
  await client.$transaction(async (transaction) => {
    await transaction.organization.create({
      data: { id: organizationId, name: 'Scoped classroom', ownerUserId: ownerId },
    });
    await transaction.organizationMembership.createMany({
      data: [
        { organizationId, userId: ownerId, role: AccountRole.TEACHER },
        { organizationId, userId: teacherId, role: AccountRole.TEACHER },
        { organizationId, userId: studentId, role: AccountRole.STUDENT },
      ],
    });
  });
  const service = new ClassroomService(classrooms.store);
  const course = await classrooms.store.saveCourse(
    teacherId,
    'Scoped course',
    createCourseContent(),
    organizationId,
  );
  const schoolClass = await classrooms.store.saveClass(
    teacherId,
    'Scoped class',
    course.id,
    organizationId,
  );
  const activity = course.content.modules[0]?.lessons[0]?.activities[0];
  if (!activity) {
    throw new Error('Missing classroom activity.');
  }
  await service.execute(teacherId, {
    kind: 'enroll',
    classId: schoolClass.id,
    email: `${studentId}@example.test`,
  });
  await service.execute(teacherId, {
    kind: 'start-session',
    classId: schoolClass.id,
    activityId: activity.id,
    pacing: ClassroomPacing.TEACHER,
  });
  const meeting = (await classrooms.store.listMeetings(schoolClass.id))[0];
  if (!meeting) {
    throw new Error('Missing classroom meeting.');
  }
  const joined = await service.execute(studentId, {
    kind: 'join',
    classSessionId: meeting.id,
    deviceId: randomUUID(),
  });
  if (joined.kind !== 'context') {
    throw new Error('Missing classroom context.');
  }
  return {
    teacherId,
    studentId,
    ownerId,
    outsideId,
    organizationId,
    schoolClass,
    course,
    activity,
    meeting,
    context: joined.context,
    service,
  };
}

it('requires organization membership plus class assignment and applies membership removal to existing participation', async () => {
  const fixture = await createOrganizationClassroom();
  const {
    service,
    teacherId,
    studentId,
    ownerId,
    outsideId,
    organizationId,
    schoolClass,
    meeting,
    context,
  } = fixture;
  for (const userId of [teacherId, studentId]) {
    expect(await service.execute(userId, { kind: 'home' })).toMatchObject({
      kind: 'home',
      home: { classes: [{ organizationId, organizationName: 'Scoped classroom' }] },
    });
  }
  expect(await classrooms.store.listClasses(ownerId)).toEqual([]);
  expect(await classrooms.store.listClasses(outsideId)).toEqual([]);
  await expect(
    service.execute(ownerId, { kind: 'session-roster', classSessionId: meeting.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await expect(
    service.execute(teacherId, {
      kind: 'enroll',
      classId: schoolClass.id,
      email: `${outsideId}@example.test`,
    }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  const invitation = await service.execute(teacherId, {
    kind: 'create-invitation',
    classId: schoolClass.id,
  });
  if (invitation.kind !== 'invitation') {
    throw new Error('Missing class invitation.');
  }
  await expect(
    service.execute(outsideId, { kind: 'accept-invitation', code: invitation.invitation.code }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await client.organizationMembership.update({
    where: { organizationId_userId: { organizationId, userId: studentId } },
    data: { removedAt: new Date() },
  });
  expect(await classrooms.store.isEnrolled(schoolClass.id, studentId)).toBe(false);
  expect(await classrooms.store.listClasses(studentId)).toEqual([]);
  await expect(
    service.execute(studentId, {
      kind: 'context',
      participationId: context.participation.id,
      deviceId: context.participation.deviceId,
      activityId: context.activity.id,
    }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  expect(await service.execute(studentId, { kind: 'resume', deviceId: randomUUID() })).toEqual({
    kind: 'ok',
  });
  expect(await insights.store.readAccess(studentId, schoolClass.id)).toBeNull();
  expect(
    (await practice.store.readAccess(context.participation.id, context.activity.id))?.enrolled,
  ).toBe(false);
  expect((await practice.store.readEvidenceAccess(context.attempt.id))?.enrolled).toBe(false);
  const petService = new PetWorldService(pets.store);
  await expect(
    petService.execute(studentId, {
      kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
      classId: schoolClass.id,
    }),
  ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
});

it('keeps enrollment when a member becomes a teacher and denies teaching immediately after demotion', async () => {
  const { service, teacherId, studentId, organizationId, schoolClass, meeting, context } =
    await createOrganizationClassroom();
  await client.organizationMembership.update({
    where: { organizationId_userId: { organizationId, userId: studentId } },
    data: { role: AccountRole.TEACHER },
  });
  expect(await classrooms.store.isEnrolled(schoolClass.id, studentId)).toBe(true);
  await expect(
    service.execute(studentId, {
      kind: 'context',
      participationId: context.participation.id,
      deviceId: context.participation.deviceId,
      activityId: context.activity.id,
    }),
  ).resolves.toMatchObject({ kind: 'context' });
  expect((await insights.store.readAccess(studentId, schoolClass.id))?.isTeacher).toBe(false);
  expect((await insights.store.readAccess(studentId, schoolClass.id))?.studentIds).toContain(
    studentId,
  );
  expect(
    (await practice.store.readAccess(context.participation.id, context.activity.id))?.enrolled,
  ).toBe(true);
  await expect(
    service.execute(studentId, { kind: 'session-roster', classSessionId: meeting.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await client.organizationMembership.update({
    where: { organizationId_userId: { organizationId, userId: teacherId } },
    data: { role: AccountRole.STUDENT },
  });
  await expect(
    service.execute(teacherId, { kind: 'session-roster', classSessionId: meeting.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  expect((await insights.store.readAccess(teacherId, schoolClass.id))?.isTeacher).toBe(false);
  expect((await practice.store.readEvidenceAccess(context.attempt.id))?.teacherAuthorized).toBe(
    false,
  );
  expect(await practice.store.readTeacherHistory(teacherId, meeting.id)).toBeNull();
  await expect(
    new ClassroomLessonSources(classrooms.store).authorize(teacherId, schoolClass.id),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    new PetWorldService(pets.store).execute(teacherId, {
      kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
      classId: schoolClass.id,
    }),
  ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
});

it('selects the only teaching organization and requires explicit scope for multiple teaching memberships', async () => {
  const { service, teacherId, ownerId, organizationId, course } =
    await createOrganizationClassroom();
  await service.execute(teacherId, { kind: 'create-class', name: 'Automatic organization' });
  const created = await client.classroomGroup.findFirstOrThrow({
    where: { teacherId, name: 'Automatic organization' },
  });
  expect(created.organizationId).toBe(organizationId);
  const secondId = randomUUID();
  await client.$transaction(async (transaction) => {
    await transaction.organization.create({
      data: { id: secondId, name: 'Second organization', ownerUserId: ownerId },
    });
    await transaction.organizationMembership.createMany({
      data: [
        { organizationId: secondId, userId: ownerId, role: AccountRole.TEACHER },
        { organizationId: secondId, userId: teacherId, role: AccountRole.TEACHER },
      ],
    });
  });
  await expect(
    service.execute(teacherId, { kind: 'create-class', name: 'Ambiguous organization' }),
  ).rejects.toMatchObject({ code: ClassroomFailure.INVALID });
  await expect(
    service.execute(teacherId, {
      kind: 'create-class',
      name: 'Foreign course',
      organizationId: secondId,
      courseRevisionId: course.id,
    }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await service.execute(teacherId, {
    kind: 'create-class',
    name: 'Selected organization',
    organizationId: secondId,
  });
  expect(
    (
      await client.classroomGroup.findFirstOrThrow({
        where: { teacherId, name: 'Selected organization' },
      })
    ).organizationId,
  ).toBe(secondId);
  const reply = await service.execute(teacherId, { kind: 'home' });
  expect(reply).toMatchObject({ kind: 'home', home: { role: AccountRole.TEACHER } });
  if (reply.kind !== 'home') {
    throw new Error('Missing classroom home.');
  }
  expect(reply.home.teachingOrganizations).toEqual(
    expect.arrayContaining([
      { id: organizationId, name: 'Scoped classroom' },
      { id: secondId, name: 'Second organization' },
    ]),
  );
});

it('keeps personal pet entitlement independent from global roles and preserves it after organization removal', async () => {
  const { studentId, organizationId } = await createOrganizationClassroom();
  const service = new PetWorldService(pets.store);
  expect(await service.execute(studentId, { kind: PetWorldCommandKind.OWN_WORLD })).toMatchObject({
    kind: 'world',
    world: { wallet: { balance: '0' }, profile: null },
  });
  expect(await client.petWallet.findUnique({ where: { studentId } })).toBeNull();
  await service.execute(studentId, {
    kind: PetWorldCommandKind.INITIALIZE_WORLD,
    requestId: randomUUID(),
    activePetId: PetId.CAT,
    names: { cat: 'Mochi', fox: 'Maple' },
  });
  await client.organizationMembership.update({
    where: { organizationId_userId: { organizationId, userId: studentId } },
    data: { removedAt: new Date() },
  });
  expect(await service.execute(studentId, { kind: PetWorldCommandKind.OWN_WORLD })).toMatchObject({
    kind: 'world',
    world: { wallet: { balance: '0' }, profile: { activePetId: PetId.CAT } },
  });
});

it('reassigns one scoped class and applies the new teacher across class, insight, practice and lesson access', async () => {
  const { service, teacherId, ownerId, studentId, organizationId, schoolClass, meeting, context } =
    await createOrganizationClassroom();
  await client.organization.update({
    where: { id: organizationId },
    data: { nameSetAt: new Date() },
  });
  const command = {
    kind: OrganizationAction.ASSIGN_CLASS_TEACHER,
    organizationId,
    classId: schoolClass.id,
    teacherId: ownerId,
    expectedTeacherId: teacherId,
  };
  await expect(organizationService.execute(ownerId, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
  await service.execute(teacherId, {
    kind: 'end-session',
    classSessionId: meeting.id,
    contextVersion: meeting.contextVersion,
  });
  const oldInvitation = await service.execute(teacherId, {
    kind: 'create-invitation',
    classId: schoolClass.id,
  });
  if (oldInvitation.kind !== 'invitation') {
    throw new Error('Missing invitation');
  }
  await organizationService.execute(ownerId, command);
  expect(await classrooms.store.listClasses(ownerId)).toMatchObject([
    { id: schoolClass.id, teacherId: ownerId },
  ]);
  expect(await classrooms.store.listClasses(teacherId)).toEqual([]);
  expect(await classrooms.store.listClasses(studentId)).toMatchObject([{ id: schoolClass.id }]);
  expect((await insights.store.readAccess(ownerId, schoolClass.id))?.isTeacher).toBe(true);
  expect((await insights.store.readAccess(teacherId, schoolClass.id))?.isTeacher).toBe(false);
  expect(await practice.store.readTeacherHistory(ownerId, meeting.id)).not.toBeNull();
  expect(await practice.store.readTeacherHistory(teacherId, meeting.id)).toBeNull();
  expect((await practice.store.readEvidenceAccess(context.attempt.id))?.teacherId).toBe(ownerId);
  await expect(
    new ClassroomLessonSources(classrooms.store).authorize(ownerId, schoolClass.id),
  ).resolves.toBeUndefined();
  await expect(
    new ClassroomLessonSources(classrooms.store).authorize(teacherId, schoolClass.id),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    service.execute(teacherId, { kind: 'session-roster', classSessionId: meeting.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await expect(
    service.execute(ownerId, { kind: 'session-roster', classSessionId: meeting.id }),
  ).resolves.toMatchObject({ kind: 'roster' });
  await expect(
    service.execute(studentId, { kind: 'accept-invitation', code: oldInvitation.invitation.code }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  const home = await service.execute(ownerId, { kind: 'home' });
  expect(home).toMatchObject({
    kind: 'home',
    home: {
      classes: [{ schoolClass: { id: schoolClass.id }, canTeach: true }],
      courses: [{ id: schoolClass.courseRevisionId }],
    },
  });
});

it('moves an explicitly selected personal class and course together without granting unassigned teachers access', async () => {
  const { ownerId, teacherId, studentId, outsideId, organizationId } =
    await createOrganizationClassroom();
  await client.organization.update({
    where: { id: organizationId },
    data: { nameSetAt: new Date() },
  });
  const course = await classrooms.store.saveCourse(
    ownerId,
    'Personal course',
    createCourseContent(),
  );
  const schoolClass = await classrooms.store.saveClass(ownerId, 'Personal class', course.id);
  await classrooms.store.enrollStudent(schoolClass.id, outsideId, true);
  const command = { kind: OrganizationAction.LINK_CLASS, organizationId, classId: schoolClass.id };
  await expect(organizationService.execute(ownerId, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
  expect(await classrooms.store.readClassOrganizationId(schoolClass.id)).toBeNull();
  expect(await classrooms.store.readCourseOrganizationId(course.id)).toBeNull();
  await classrooms.store.enrollStudent(schoolClass.id, outsideId, false);
  await classrooms.store.enrollStudent(schoolClass.id, studentId, true);
  const duplicate = await classrooms.store.saveClass(ownerId, 'Shared class', course.id);
  await expect(organizationService.execute(ownerId, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
  await client.classroomGroup.delete({ where: { id: duplicate.id } });
  const personal = await organizationService.execute(ownerId, {
    kind: OrganizationAction.TEAM,
    organizationId,
  });
  expect(personal).toMatchObject({ personalClasses: [{ id: schoolClass.id }] });
  await organizationService.execute(ownerId, command);
  expect(await classrooms.store.readClassOrganizationId(schoolClass.id)).toBe(organizationId);
  expect(await classrooms.store.readCourseOrganizationId(course.id)).toBe(organizationId);
  expect(await classrooms.store.listClasses(ownerId)).toMatchObject([{ id: schoolClass.id }]);
  expect(
    (await classrooms.store.listClasses(teacherId)).some((item) => item.id === schoolClass.id),
  ).toBe(false);
  expect(
    (await classrooms.store.listClasses(studentId)).some((item) => item.id === schoolClass.id),
  ).toBe(true);
  expect(
    (await classrooms.store.listClasses(outsideId)).some((item) => item.id === schoolClass.id),
  ).toBe(false);
});

it('rejects a stale owner assignment after a competing teacher change commits', async () => {
  const { service, ownerId, teacherId, outsideId, organizationId, schoolClass, meeting } =
    await createOrganizationClassroom();
  await client.organization.update({
    where: { id: organizationId },
    data: { nameSetAt: new Date() },
  });
  await client.organizationMembership.create({
    data: { organizationId, userId: outsideId, role: AccountRole.TEACHER },
  });
  await service.execute(teacherId, {
    kind: 'end-session',
    classSessionId: meeting.id,
    contextVersion: meeting.contextVersion,
  });
  const command = {
    kind: OrganizationAction.ASSIGN_CLASS_TEACHER,
    organizationId,
    classId: schoolClass.id,
    teacherId: ownerId,
    expectedTeacherId: teacherId,
  };
  const results = await Promise.allSettled([
    organizationService.execute(ownerId, command),
    organizationService.execute(ownerId, { ...command, teacherId: outsideId }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect((await classrooms.store.readClass(schoolClass.id))?.teacherId).not.toBe(teacherId);
});

it('shares a scoped class with multiple assigned teachers while keeping unassigned teachers and removed assignments out', async () => {
  const { service, teacherId, ownerId, outsideId, organizationId, schoolClass, meeting, context } =
    await createOrganizationClassroom();
  await client.organization.update({
    where: { id: organizationId },
    data: { nameSetAt: new Date() },
  });
  await client.organizationMembership.create({
    data: { organizationId, userId: outsideId, role: AccountRole.TEACHER },
  });
  await service.execute(teacherId, {
    kind: 'end-session',
    classSessionId: meeting.id,
    contextVersion: meeting.contextVersion,
  });
  const command = {
    kind: OrganizationAction.SET_CLASS_TEACHERS,
    organizationId,
    classId: schoolClass.id,
    teacherIds: [teacherId, ownerId],
    expectedTeacherIds: [teacherId],
  };
  await organizationService.execute(ownerId, command);
  const materials = new MaterialService(
    classrooms.store,
    { extract: () => Promise.resolve([]) },
    {
      available: false,
      prepare: () => Promise.reject(new Error('No model needed for permission checks')),
    },
  );
  for (const userId of [teacherId, ownerId]) {
    expect(
      (await classrooms.store.listClasses(userId)).some((item) => item.id === schoolClass.id),
    ).toBe(true);
    expect(await service.execute(userId, { kind: 'home' })).toMatchObject({
      kind: 'home',
      home: { classes: [{ canTeach: true }], courses: [{ id: schoolClass.courseRevisionId }] },
    });
    await expect(
      service.execute(userId, { kind: 'session-roster', classSessionId: meeting.id }),
    ).resolves.toMatchObject({ kind: 'roster' });
    expect((await insights.store.readAccess(userId, schoolClass.id))?.isTeacher).toBe(true);
    await expect(
      materials.execute(userId, { kind: 'read', classId: schoolClass.id }),
    ).resolves.toMatchObject({ kind: 'collection' });
    expect(await practice.store.readTeacherHistory(userId, meeting.id)).not.toBeNull();
    await expect(
      new ClassroomLessonSources(classrooms.store).authorize(userId, schoolClass.id),
    ).resolves.toBeUndefined();
    await expect(
      new PetWorldService(pets.store).execute(userId, {
        kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
        classId: schoolClass.id,
      }),
    ).resolves.toMatchObject({ kind: 'neighborhood' });
  }
  expect(
    (await practice.store.readEvidenceAccess(context.attempt.id))?.authorizedTeacherIds,
  ).toEqual(expect.arrayContaining([teacherId, ownerId]));
  expect(await classrooms.store.listClasses(outsideId)).toEqual([]);
  await expect(
    service.execute(outsideId, { kind: 'session-roster', classSessionId: meeting.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await organizationService.execute(ownerId, {
    ...command,
    teacherIds: [teacherId],
    expectedTeacherIds: [teacherId, ownerId],
  });
  expect(await classrooms.store.listClasses(ownerId)).toEqual([]);
  await expect(
    materials.execute(ownerId, { kind: 'read', classId: schoolClass.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  expect((await insights.store.readAccess(ownerId, schoolClass.id))?.isTeacher).toBe(false);
  expect(await practice.store.readTeacherHistory(ownerId, meeting.id)).toBeNull();
  expect(
    (await practice.store.readEvidenceAccess(context.attempt.id))?.authorizedTeacherIds,
  ).toEqual([teacherId]);
  await expect(
    new ClassroomLessonSources(classrooms.store).authorize(ownerId, schoolClass.id),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    new PetWorldService(pets.store).execute(ownerId, {
      kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
      classId: schoolClass.id,
    }),
  ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });
});

it('revokes stored legacy QR codes when an owner links their class to an organization', async () => {
  const { ownerId, organizationId } = await createOrganizationClassroom();
  await client.organization.update({
    where: { id: organizationId },
    data: { nameSetAt: new Date() },
  });
  const course = await classrooms.store.saveCourse(
    ownerId,
    'Personal QR course',
    createCourseContent(),
  );
  const personal = await classrooms.store.saveClass(ownerId, 'Personal QR class', course.id);
  const school = await client.studentSchool.create({
    data: { id: randomUUID(), ownerId, name: 'Stored legacy school' },
  });
  const admissionId = randomUUID();
  await client.studentAdmission.create({
    data: {
      id: admissionId,
      schoolId: school.id,
      classId: personal.id,
      codeDigest: randomUUID(),
      mode: StudentDeviceMode.PERSONAL,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await organizationService.execute(ownerId, {
    kind: OrganizationAction.LINK_CLASS,
    organizationId,
    classId: personal.id,
  });
  expect(
    (await client.studentAdmission.findUniqueOrThrow({ where: { id: admissionId } })).revoked,
  ).toBe(true);
  expect(await client.studentAdmission.count({ where: { classId: personal.id } })).toBe(1);
});

it('scopes an administrator across classroom, materials, insights, practice, team and lesson sources without impersonation', async () => {
  const { adminOrganizationContext } =
    await import('../../../src/server/auth/AdminOrganizationContext.js');
  const first = await createOrganizationClassroom();
  const second = await createOrganizationClassroom();
  const adminId = randomUUID();
  await client.user.create({
    data: {
      id: adminId,
      name: 'Platform administrator',
      email: `${adminId}@example.test`,
      emailVerified: true,
      isAdmin: true,
    },
  });
  // Finish permanent name setup so all team mutations are available.
  await client.organization.update({
    where: { id: first.organizationId },
    data: { nameSetAt: new Date() },
  });
  const sources = new ClassroomLessonSources(classrooms.store);
  expect(await classrooms.store.canTeachClass(adminId, first.schoolClass.id)).toBe(false);
  await adminOrganizationContext.run(
    { actorId: adminId, organizationId: first.organizationId },
    async () => {
      const home = await first.service.execute(adminId, { kind: 'home' });
      expect(home).toMatchObject({
        kind: 'home',
        home: {
          role: AccountRole.TEACHER,
          adminOrganizationId: first.organizationId,
        },
      });
      if (home.kind !== 'home') {
        throw new Error('Missing home');
      }
      expect(home.home.organizationTeachers?.map((teacher) => teacher.id)).toContain(
        first.teacherId,
      );
      expect(home.home.classes.map((entry) => entry.schoolClass.id)).toEqual([
        first.schoolClass.id,
      ]);
      expect(home.home.classes[0]?.schoolClass.teacherId).toBe(first.teacherId);
      expect(
        (
          await first.service.execute(adminId, {
            kind: 'session-roster',
            classSessionId: first.meeting.id,
          })
        ).kind,
      ).toBe('roster');
      await expect(
        second.service.execute(adminId, {
          kind: 'session-roster',
          classSessionId: second.meeting.id,
        }),
      ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
      expect(await classrooms.store.canTeachClass(adminId, second.schoolClass.id)).toBe(false);
      const materials = new MaterialService(
        classrooms.store,
        { extract: () => Promise.resolve([]) },
        { available: false, prepare: () => Promise.reject(new Error('No provider needed')) },
      );
      expect(
        (await materials.execute(adminId, { kind: 'read', classId: first.schoolClass.id })).kind,
      ).toBe('collection');
      await expect(
        materials.execute(adminId, { kind: 'read', classId: second.schoolClass.id }),
      ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
      const petService = new PetWorldService(pets.store);
      expect(
        (
          await petService.execute(adminId, {
            kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
            classId: first.schoolClass.id,
          })
        ).kind,
      ).toBe('neighborhood');
      await expect(
        petService.execute(adminId, {
          kind: PetWorldCommandKind.CLASS_NEIGHBORHOOD,
          classId: second.schoolClass.id,
        }),
      ).rejects.toMatchObject({ code: PetWorldFailure.FORBIDDEN });

      expect((await insights.store.readAccess(adminId, first.schoolClass.id))?.isTeacher).toBe(
        true,
      );
      expect(await insights.store.readAccess(adminId, second.schoolClass.id)).toBeNull();
      expect(await practice.store.readTeacherHistory(adminId, first.meeting.id)).not.toBeNull();
      expect(await practice.store.readTeacherHistory(adminId, second.meeting.id)).toBeNull();
      expect((await sources.list(adminId)).map((entry) => entry.id)).toEqual([
        first.schoolClass.id,
      ]);
      expect(await sources.canAdminister(adminId, first.schoolClass.id)).toBe(true);
      expect(await sources.canAdminister(adminId, second.schoolClass.id)).toBe(false);
      await expect(sources.authorize(adminId, second.schoolClass.id)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(
        (
          await organizationService.execute(adminId, {
            kind: OrganizationAction.TEAM,
            organizationId: first.organizationId,
          })
        ).kind,
      ).toBe('team');
      await expect(
        organizationService.execute(adminId, {
          kind: OrganizationAction.TEAM,
          organizationId: second.organizationId,
        }),
      ).rejects.toMatchObject({ code: OrganizationFailure.FORBIDDEN });
      await organizationService.execute(adminId, {
        kind: OrganizationAction.ADD_MEMBER,
        organizationId: first.organizationId,
        email: 'reserved-admin-test@example.test',
        role: AccountRole.STUDENT,
      });
      await first.service.execute(adminId, {
        kind: 'create-class',
        name: 'Admin-created class',
        organizationId: first.organizationId,
        teacherId: first.teacherId,
      });
      const created = (await classrooms.store.listClasses(adminId)).find(
        (entry) => entry.name === 'Admin-created class',
      );
      expect(created?.teacherId).toBe(first.teacherId);
      await expect(
        first.service.execute(adminId, {
          kind: 'create-class',
          name: 'Invalid assignment',
          organizationId: first.organizationId,
          teacherId: second.teacherId,
        }),
      ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
      await expect(
        first.service.execute(adminId, {
          kind: 'create-class',
          name: 'No teacher',
          organizationId: first.organizationId,
        }),
      ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
      expect(await client.organizationMembership.count({ where: { userId: adminId } })).toBe(0);
      expect(
        (await client.organization.findUnique({ where: { id: first.organizationId } }))
          ?.ownerUserId,
      ).toBe(first.ownerId);
      await client.user.update({ where: { id: adminId }, data: { isAdmin: false } });
      expect(await classrooms.store.canTeachClass(adminId, first.schoolClass.id)).toBe(false);
      await expect(
        organizationService.execute(adminId, {
          kind: OrganizationAction.TEAM,
          organizationId: first.organizationId,
        }),
      ).rejects.toMatchObject({ code: OrganizationFailure.FORBIDDEN });
    },
  );
  await client.user.update({ where: { id: adminId }, data: { isAdmin: true } });
  await adminOrganizationContext.run(
    { actorId: adminId, organizationId: second.organizationId },
    async () => {
      expect((await classrooms.store.listClasses(adminId)).map((entry) => entry.id)).toEqual([
        second.schoolClass.id,
      ]);
      expect(await classrooms.store.canTeachClass(adminId, first.schoolClass.id)).toBe(false);
    },
  );
});
