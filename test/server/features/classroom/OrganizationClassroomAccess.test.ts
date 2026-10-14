import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { ClassroomFailure, ClassroomPacing } from '#contracts/Classroom.js';
import { ClassroomService } from '../../../../src/server/features/classroom/application/ClassroomService.js';
import { ClassroomLessonSources } from '../../../../src/server/features/lessonVideos/infrastructure/ClassroomLessonSources.js';
import { MemoryClassroomStore } from './ClassroomFixtures.js';

async function createScopedClassroom() {
  const store = new MemoryClassroomStore();
  const organizationId = randomUUID();
  store.organizationMemberships.set(`${organizationId}:member`, {
    organizationId,
    role: AccountRole.TEACHER,
    name: 'Teaching team',
  });
  const service = new ClassroomService(store);
  await service.execute('member', { kind: 'create-class', name: 'Scoped class' });
  const schoolClass = [...store.classes.values()][0];
  const course = schoolClass ? await store.readCourse(schoolClass.courseRevisionId) : null;
  const activity = course?.content.modules[0]?.lessons[0]?.activities[0];
  if (!schoolClass || !activity) {
    throw new Error('Missing classroom fixture.');
  }
  return { store, service, organizationId, schoolClass, activity };
}

it('uses teaching membership independently from the global account role and owner identity', async () => {
  const { store, service, organizationId, schoolClass } = await createScopedClassroom();
  expect(await store.readAccountRole('member')).toBe(AccountRole.STUDENT);
  expect(await store.readClassOrganizationId(schoolClass.id)).toBe(organizationId);
  expect(await store.readCourseOrganizationId(schoolClass.courseRevisionId)).toBe(organizationId);
  expect(await service.execute('member', { kind: 'home' })).toMatchObject({
    kind: 'home',
    home: {
      role: AccountRole.TEACHER,
      teachingOrganizations: [{ id: organizationId, name: 'Teaching team' }],
    },
  });
  store.organizationMemberships.set(`${organizationId}:owner`, {
    organizationId,
    role: AccountRole.TEACHER,
    name: 'Teaching team',
  });
  await expect(
    service.execute('owner', { kind: 'create-invitation', classId: schoolClass.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await expect(
    service.execute('member', {
      kind: 'enroll',
      classId: schoolClass.id,
      email: 'outside@example.test',
    }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
});

it('requires a selected organization for ambiguous teaching membership and refuses foreign course reuse', async () => {
  const { store, service, organizationId, schoolClass } = await createScopedClassroom();
  const secondId = randomUUID();
  store.organizationMemberships.set(`${secondId}:member`, {
    organizationId: secondId,
    role: AccountRole.TEACHER,
    name: 'Second team',
  });
  await expect(
    service.execute('member', { kind: 'create-class', name: 'Ambiguous' }),
  ).rejects.toMatchObject({ code: ClassroomFailure.INVALID });
  await expect(
    service.execute('member', {
      kind: 'create-class',
      name: 'Foreign course',
      organizationId: secondId,
      courseRevisionId: schoolClass.courseRevisionId,
    }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await expect(
    service.execute('member', { kind: 'create-class', name: 'Selected', organizationId }),
  ).resolves.toEqual({ kind: 'ok' });
});

it('allows teacher members to enroll while current membership removal revokes a saved session', async () => {
  const { store, service, organizationId, schoolClass, activity } = await createScopedClassroom();
  store.organizationMemberships.set(`${organizationId}:student`, {
    organizationId,
    role: AccountRole.STUDENT,
    name: 'Teaching team',
  });
  const invitation = await service.execute('member', {
    kind: 'create-invitation',
    classId: schoolClass.id,
  });
  if (invitation.kind !== 'invitation') {
    throw new Error('Missing invitation.');
  }
  await expect(
    service.execute('outside', { kind: 'accept-invitation', code: invitation.invitation.code }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await service.execute('student', { kind: 'accept-invitation', code: invitation.invitation.code });
  await service.execute('member', {
    kind: 'start-session',
    classId: schoolClass.id,
    activityId: activity.id,
    pacing: ClassroomPacing.TEACHER,
  });
  const meeting = (await store.listMeetings(schoolClass.id))[0];
  if (!meeting) {
    throw new Error('Missing meeting.');
  }
  const joined = await service.execute('student', {
    kind: 'join',
    classSessionId: meeting.id,
    deviceId: randomUUID(),
  });
  if (joined.kind !== 'context') {
    throw new Error('Missing joined context.');
  }
  const contextCommand = {
    kind: 'context',
    participationId: joined.context.participation.id,
    deviceId: joined.context.participation.deviceId,
    activityId: activity.id,
  } as const;
  store.organizationMemberships.set(`${organizationId}:student`, {
    organizationId,
    role: AccountRole.TEACHER,
    name: 'Teaching team',
  });
  await expect(service.execute('student', contextCommand)).resolves.toMatchObject({
    kind: 'context',
  });
  store.organizationMemberships.delete(`${organizationId}:student`);
  await expect(service.execute('student', contextCommand)).rejects.toMatchObject({
    code: ClassroomFailure.FORBIDDEN,
  });
  expect(await store.listClasses('student')).toEqual([]);
  store.organizationMemberships.set(`${organizationId}:member`, {
    organizationId,
    role: AccountRole.STUDENT,
    name: 'Teaching team',
  });
  await expect(
    service.execute('member', { kind: 'session-roster', classSessionId: meeting.id }),
  ).rejects.toMatchObject({ code: ClassroomFailure.FORBIDDEN });
  await expect(
    new ClassroomLessonSources(store).authorize('member', schoolClass.id),
  ).rejects.toMatchObject({ code: 'forbidden' });
});
