import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { OrganizationAction, OrganizationFailure } from '#contracts/Organizations.js';
import { createOrganizationFixture } from './OrganizationFixtures.js';

async function createClassFixture() {
  const fixture = await createOrganizationFixture();
  const { store, service, owner, member, organization } = fixture;
  for (const account of [owner, member]) {
    await store.saveMembership({
      organizationId: organization.id,
      userId: account.id,
      role: AccountRole.TEACHER,
      joinedAt: fixture.now,
      removedAt: null,
    });
  }
  const schoolClass = {
    id: randomUUID(),
    name: 'Programming',
    teacherId: owner.id,
    organizationId: organization.id,
    courseRevisionId: randomUUID(),
    hasLiveSession: false,
    canLinkCourse: false,
    enrolledUserIds: [],
  };
  store.classes.set(schoolClass.id, schoolClass);
  const command = {
    kind: OrganizationAction.ASSIGN_CLASS_TEACHER,
    organizationId: organization.id,
    classId: schoolClass.id,
    teacherId: member.id,
    expectedTeacherId: owner.id,
  };
  return { ...fixture, schoolClass, command, service };
}

it('allows only the organization owner to assign an active teacher to a class in that organization', async () => {
  const { service, store, owner, member, stranger, admin, organization, schoolClass, command } =
    await createClassFixture();
  for (const account of [member, stranger, admin]) {
    await expect(service.execute(account.id, command)).rejects.toMatchObject({
      code: OrganizationFailure.FORBIDDEN,
    });
  }
  await expect(
    service.execute(owner.id, { ...command, teacherId: stranger.id }),
  ).rejects.toMatchObject({ code: OrganizationFailure.FORBIDDEN });
  await store.saveMembership({
    organizationId: organization.id,
    userId: stranger.id,
    role: AccountRole.STUDENT,
    joinedAt: new Date(),
    removedAt: null,
  });
  await expect(
    service.execute(owner.id, { ...command, teacherId: stranger.id }),
  ).rejects.toMatchObject({ code: OrganizationFailure.FORBIDDEN });
  store.classes.set(schoolClass.id, { ...schoolClass, organizationId: randomUUID() });
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.FORBIDDEN,
  });
  store.classes.set(schoolClass.id, schoolClass);
  await service.execute(owner.id, command);
  expect(await store.readClass(schoolClass.id)).toMatchObject({ teacherId: member.id });
  expect(
    await service.execute(owner.id, {
      kind: OrganizationAction.TEAM,
      organizationId: organization.id,
    }),
  ).toMatchObject({ classes: [{ id: schoolClass.id, teacherId: member.id }] });
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
});

it('refuses reassignment during live sessions or to removed teachers', async () => {
  const { service, store, owner, member, organization, schoolClass, command, now } =
    await createClassFixture();
  store.classes.set(schoolClass.id, { ...schoolClass, hasLiveSession: true });
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
  store.classes.set(schoolClass.id, schoolClass);
  await store.removeMember(organization.id, member.id, now);
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.FORBIDDEN,
  });
  expect((await store.readClass(schoolClass.id))?.teacherId).toBe(owner.id);
});

it('links only the owner’s personal class with its own course and current team enrollments', async () => {
  const { service, store, owner, member, stranger, organization, schoolClass } =
    await createClassFixture();
  const personal = {
    ...schoolClass,
    organizationId: null,
    canLinkCourse: true,
    enrolledUserIds: [stranger.id],
  };
  const command = {
    kind: OrganizationAction.LINK_CLASS,
    organizationId: organization.id,
    classId: schoolClass.id,
  };
  store.classes.set(schoolClass.id, personal);
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
  store.classes.set(schoolClass.id, { ...personal, enrolledUserIds: [], canLinkCourse: false });
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
  store.classes.set(schoolClass.id, { ...personal, enrolledUserIds: [], teacherId: member.id });
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.FORBIDDEN,
  });
  store.classes.set(schoolClass.id, { ...personal, enrolledUserIds: [], hasLiveSession: true });
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
  store.classes.set(schoolClass.id, personal);
  await service.execute(owner.id, {
    kind: OrganizationAction.ADD_MEMBER,
    organizationId: organization.id,
    email: stranger.email,
    role: AccountRole.STUDENT,
  });
  await service.execute(owner.id, command);
  expect(await store.readClass(schoolClass.id)).toMatchObject({
    organizationId: organization.id,
    teacherId: owner.id,
  });
  expect(await store.listPersonalClasses(owner.id)).toEqual([]);
});

it('keeps multiple assigned teachers, rejects unauthorized additions and protects concurrent edits', async () => {
  const { service, store, owner, member, stranger, organization, schoolClass } =
    await createClassFixture();
  const command = {
    kind: OrganizationAction.SET_CLASS_TEACHERS,
    organizationId: organization.id,
    classId: schoolClass.id,
    teacherIds: [owner.id, member.id],
    expectedTeacherIds: [owner.id],
  };
  await expect(service.execute(member.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.FORBIDDEN,
  });
  await expect(
    service.execute(owner.id, { ...command, teacherIds: [owner.id, stranger.id] }),
  ).rejects.toMatchObject({ code: OrganizationFailure.FORBIDDEN });
  await service.execute(owner.id, command);
  expect(await store.readClass(schoolClass.id)).toMatchObject({
    teacherIds: [owner.id, member.id],
  });
  expect(
    await service.execute(owner.id, {
      kind: OrganizationAction.TEAM,
      organizationId: organization.id,
    }),
  ).toMatchObject({ classes: [{ teacherIds: [owner.id, member.id] }] });
  await expect(service.execute(owner.id, command)).rejects.toMatchObject({
    code: OrganizationFailure.CONFLICT,
  });
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.ASSIGN_CLASS_TEACHER,
      organizationId: organization.id,
      classId: schoolClass.id,
      teacherId: member.id,
      expectedTeacherId: owner.id,
    }),
  ).rejects.toMatchObject({ code: OrganizationFailure.CONFLICT });
  await service.execute(owner.id, {
    ...command,
    teacherIds: [member.id],
    expectedTeacherIds: [owner.id, member.id],
  });
  expect(await store.readClass(schoolClass.id)).toMatchObject({ teacherIds: [member.id] });
});
