import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { expect, it } from 'vitest';
import { organizationLogo } from '../features/organizations/OrganizationLogoFixtures.js';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationFailure,
  OrganizationReplySchema,
} from '#contracts/Organizations.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { PrismaClient } from '../../../src/server/generated/prisma/client.js';
import { OrganizationService } from '../../../src/server/features/organizations/application/OrganizationService.js';
import { OrganizationError } from '../../../src/server/features/organizations/domain/OrganizationError.js';
import { createPrismaOrganizationStore } from '../../../src/server/persistence/PrismaOrganizationStore.js';

function createDatabaseFixture() {
  const environment = readServerEnv(process.env);
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: environment.DATABASE_URL }),
  });
  const database = createPrismaOrganizationStore(environment.DATABASE_URL);
  const service = new OrganizationService(database.store);
  const prefix = randomUUID();
  const admin = {
    id: randomUUID(),
    name: 'Admin',
    email: `${prefix}-admin@example.test`,
    emailVerified: true,
    isAdmin: true,
  };
  const owner = {
    id: randomUUID(),
    name: 'Owner',
    email: `${prefix}-owner@example.test`,
    emailVerified: true,
  };
  const member = {
    id: randomUUID(),
    name: 'Member',
    email: `${prefix}-member@example.test`,
    emailVerified: true,
  };
  const stranger = {
    id: randomUUID(),
    name: 'Stranger',
    email: `${prefix}-stranger@example.test`,
    emailVerified: true,
  };
  const userIds = [admin.id, owner.id, member.id, stranger.id];
  const organizationIds: string[] = [];
  const classIds: string[] = [];
  const courseIds: string[] = [];
  return {
    client,
    database,
    service,
    admin,
    owner,
    member,
    stranger,
    userIds,
    organizationIds,
    classIds,
    courseIds,
    close: async () => {
      await client.$transaction(async (transaction) => {
        await transaction.classroomParticipation.deleteMany({
          where: { studentId: { in: userIds } },
        });
        await transaction.classroomEnrollment.deleteMany({ where: { classId: { in: classIds } } });
        await transaction.classroomMeeting.deleteMany({ where: { classId: { in: classIds } } });
        await transaction.classroomGroup.deleteMany({ where: { id: { in: classIds } } });
        await transaction.classroomCourseRevision.deleteMany({ where: { id: { in: courseIds } } });
        await transaction.organizationEmailMember.deleteMany({
          where: { organizationId: { in: organizationIds } },
        });
        await transaction.organizationInvitation.deleteMany({
          where: { organizationId: { in: organizationIds } },
        });
        await transaction.organizationMembership.deleteMany({
          where: { organizationId: { in: organizationIds } },
        });
        await transaction.organization.deleteMany({ where: { id: { in: organizationIds } } });
        await transaction.user.deleteMany({ where: { id: { in: userIds } } });
      });
      await database.close();
      await client.$disconnect();
    },
  };
}

it('persists verified-email invitations, accepts once under concurrency and scopes roles without changing global roles', async () => {
  const fixture = createDatabaseFixture();
  const { client, service, admin, owner, member, stranger, organizationIds } = fixture;
  try {
    await client.user.createMany({ data: [admin, owner, member, stranger] });
    await service.execute(admin.id, {
      kind: OrganizationAction.CREATE_ORGANIZATION,
      name: `Team ${owner.id}`,
      ownerEmail: owner.email,
    });
    const organization = await client.organization.findFirstOrThrow({
      where: { ownerUserId: owner.id },
    });
    organizationIds.push(organization.id);
    await service.execute(owner.id, {
      kind: OrganizationAction.SET_NAME,
      organizationId: organization.id,
      name: `Team ${owner.id}`,
    });
    expect(
      await client.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: { organizationId: organization.id, userId: owner.id },
        },
      }),
    ).toMatchObject({ removedAt: null, role: AccountRole.STUDENT });
    const invitation = await service.execute(owner.id, {
      kind: OrganizationAction.INVITE,
      organizationId: organization.id,
      email: member.email,
      role: AccountRole.TEACHER,
    });
    if (invitation.kind !== 'invitation') {
      throw new Error('Missing invitation result.');
    }
    const invitationRow = await client.organizationInvitation.findFirstOrThrow({
      where: { organizationId: organization.id },
    });
    expect(invitationRow.codeDigest).toHaveLength(64);
    expect(JSON.stringify(invitationRow)).not.toContain(invitation.code);
    await expect(
      service.execute(stranger.id, {
        kind: OrganizationAction.ACCEPT_INVITATION,
        code: invitation.code,
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
    await client.user.update({ where: { id: member.id }, data: { emailVerified: false } });
    await expect(
      service.execute(member.id, {
        kind: OrganizationAction.ACCEPT_INVITATION,
        code: invitation.code,
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
    await client.user.update({ where: { id: member.id }, data: { emailVerified: true } });
    const accepted = await Promise.allSettled([
      service.execute(member.id, {
        kind: OrganizationAction.ACCEPT_INVITATION,
        code: invitation.code,
      }),
      service.execute(member.id, {
        kind: OrganizationAction.ACCEPT_INVITATION,
        code: invitation.code,
      }),
    ]);
    expect(accepted.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(accepted.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await client.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: { organizationId: organization.id, userId: member.id },
        },
      }),
    ).toMatchObject({ role: AccountRole.TEACHER, removedAt: null });
    expect((await client.user.findUniqueOrThrow({ where: { id: member.id } })).role).toBe(
      AccountRole.STUDENT,
    );
    const home = OrganizationReplySchema.parse(
      await service.execute(member.id, { kind: OrganizationAction.HOME }),
    );
    expect(home).toMatchObject({
      kind: 'home',
      organizations: [{ id: organization.id, role: AccountRole.TEACHER, isOwner: false }],
    });
    await expect(
      service.execute(member.id, {
        kind: OrganizationAction.TEAM,
        organizationId: organization.id,
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
    await service.execute(owner.id, {
      kind: OrganizationAction.CHANGE_ROLE,
      organizationId: organization.id,
      userId: member.id,
      role: AccountRole.STUDENT,
    });
    await expect(
      service.execute(member.id, {
        kind: OrganizationAction.ACCEPT_INVITATION,
        code: invitation.code,
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
    expect(
      await client.organizationMembership.count({
        where: { organizationId: organization.id, userId: member.id },
      }),
    ).toBe(1);
  } finally {
    await fixture.close();
  }
});

it('keeps owner membership invariant, revokes scoped enrollment on removal and preserves unscoped legacy classrooms', async () => {
  const fixture = createDatabaseFixture();
  const { client, service, admin, owner, member, stranger, organizationIds, classIds, courseIds } =
    fixture;
  try {
    await client.user.createMany({ data: [admin, owner, member, stranger] });
    await service.execute(admin.id, {
      kind: OrganizationAction.CREATE_ORGANIZATION,
      name: `Team ${owner.id}`,
      ownerEmail: owner.email,
    });
    const organization = await client.organization.findFirstOrThrow({
      where: { ownerUserId: owner.id },
    });
    organizationIds.push(organization.id);
    await service.execute(owner.id, {
      kind: OrganizationAction.SET_NAME,
      organizationId: organization.id,
      name: `Team ${owner.id}`,
    });
    const ownerKey = {
      organizationId_userId: { organizationId: organization.id, userId: owner.id },
    };
    await expect(
      client.organizationMembership.update({ where: ownerKey, data: { removedAt: new Date() } }),
    ).rejects.toThrow();
    await expect(client.organizationMembership.delete({ where: ownerKey })).rejects.toThrow();
    await expect(
      client.organizationMembership.update({ where: ownerKey, data: { userId: stranger.id } }),
    ).rejects.toThrow();
    expect(
      (await client.organizationMembership.findUniqueOrThrow({ where: ownerKey })).removedAt,
    ).toBeNull();
    await client.organizationMembership.create({
      data: { organizationId: organization.id, userId: member.id, role: AccountRole.STUDENT },
    });
    for (const scopedOrganizationId of [organization.id, null]) {
      const courseId = randomUUID();
      const classId = randomUUID();
      courseIds.push(courseId);
      classIds.push(classId);
      await client.classroomCourseRevision.create({
        data: {
          id: courseId,
          ownerId: owner.id,
          organizationId: scopedOrganizationId,
          title: 'Retained course',
          content: {},
        },
      });
      await client.classroomGroup.create({
        data: {
          id: classId,
          teacherId: owner.id,
          name: 'Retained class',
          teachers: { create: { userId: owner.id } },
          courseRevisionId: courseId,
          organizationId: scopedOrganizationId,
        },
      });
      await client.classroomEnrollment.create({ data: { classId, studentId: member.id } });
    }
    await service.execute(owner.id, {
      kind: OrganizationAction.REMOVE_MEMBER,
      organizationId: organization.id,
      userId: member.id,
    });
    const enrollments = await client.classroomEnrollment.findMany({
      where: { studentId: member.id },
      include: { schoolClass: true },
    });
    expect(
      enrollments.find((entry) => entry.schoolClass.organizationId === organization.id)?.active,
    ).toBe(false);
    expect(enrollments.find((entry) => entry.schoolClass.organizationId === null)?.active).toBe(
      true,
    );
    expect(await client.classroomGroup.count({ where: { id: { in: classIds } } })).toBe(2);
    await expect(
      service.execute(owner.id, {
        kind: OrganizationAction.GRANT_OWNER,
        organizationId: organization.id,
        email: stranger.email,
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
    await service.execute(admin.id, {
      kind: OrganizationAction.GRANT_OWNER,
      organizationId: organization.id,
      email: stranger.email,
    });
    expect(
      (await client.organization.findUniqueOrThrow({ where: { id: organization.id } })).ownerUserId,
    ).toBe(stranger.id);
    expect(
      (
        await client.organizationMembership.findUniqueOrThrow({
          where: {
            organizationId_userId: { organizationId: organization.id, userId: stranger.id },
          },
        })
      ).removedAt,
    ).toBeNull();
    expect(
      (await client.organizationMembership.findUniqueOrThrow({ where: ownerKey })).removedAt,
    ).toBeNull();
    await expect(
      service.execute(owner.id, { kind: OrganizationAction.TEAM, organizationId: organization.id }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
    await client.user.update({ where: { id: admin.id }, data: { isAdmin: false } });
    await expect(
      service.execute(admin.id, {
        kind: OrganizationAction.GRANT_OWNER,
        organizationId: organization.id,
        email: owner.email,
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  } finally {
    await fixture.close();
  }
});

it('does not appoint an arbitrary owner when historical verified emails differ only in case', async () => {
  const fixture = createDatabaseFixture();
  const { client, service, admin, owner, member, stranger, userIds, organizationIds } = fixture;
  const duplicate = { ...member, id: randomUUID(), email: member.email.toUpperCase() };
  userIds.push(duplicate.id);
  try {
    await client.user.createMany({ data: [admin, owner, member, stranger, duplicate] });
    await service.execute(admin.id, {
      kind: OrganizationAction.CREATE_ORGANIZATION,
      name: `Team ${owner.id}`,
      ownerEmail: owner.email,
    });
    const organization = await client.organization.findFirstOrThrow({
      where: { ownerUserId: owner.id },
    });
    organizationIds.push(organization.id);
    await service.execute(owner.id, {
      kind: OrganizationAction.SET_NAME,
      organizationId: organization.id,
      name: `Team ${owner.id}`,
    });
    await expect(
      service.execute(admin.id, {
        kind: OrganizationAction.GRANT_OWNER,
        organizationId: organization.id,
        email: member.email,
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.NOT_FOUND));
    expect(
      (await client.organization.findUniqueOrThrow({ where: { id: organization.id } })).ownerUserId,
    ).toBe(owner.id);
  } finally {
    await fixture.close();
  }
});

it('commits only one permanent name under competing saves and keeps the database lock through ownership transfer', async () => {
  const fixture = createDatabaseFixture();
  const { client, service, database, admin, owner, member, stranger, organizationIds } = fixture;
  try {
    await client.user.createMany({ data: [admin, owner, member, stranger] });
    await service.execute(admin.id, {
      kind: OrganizationAction.CREATE_ORGANIZATION,
      ownerEmail: owner.email,
    });
    const organization = await client.organization.findFirstOrThrow({
      where: { ownerUserId: owner.id },
    });
    organizationIds.push(organization.id);
    expect(organization.nameSetAt).toBeNull();
    const outcomes = await Promise.allSettled(
      ['School one', 'School two'].map((name) =>
        service.execute(owner.id, {
          kind: OrganizationAction.SET_NAME,
          organizationId: organization.id,
          name,
        }),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const saved = await client.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(saved.nameSetAt).not.toBeNull();
    expect(['School one', 'School two']).toContain(saved.name);
    await expect(
      database.store.runAtomically((store) =>
        store.setOrganizationName(organization.id, 'Bypass', new Date()),
      ),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
    await expect(
      client.organization.update({ where: { id: organization.id }, data: { name: 'Bypass' } }),
    ).rejects.toThrow();
    await expect(
      client.organization.update({ where: { id: organization.id }, data: { nameSetAt: null } }),
    ).rejects.toThrow();
    await service.execute(admin.id, {
      kind: OrganizationAction.GRANT_OWNER,
      organizationId: organization.id,
      email: member.email,
    });
    await expect(
      service.execute(member.id, {
        kind: OrganizationAction.SET_NAME,
        organizationId: organization.id,
        name: 'New owner name',
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
    const home = await service.execute(member.id, { kind: OrganizationAction.HOME });
    expect(home).toMatchObject({
      kind: 'home',
      organizations: [{ name: saved.name, isNameSet: true, isOwner: true }],
    });
  } finally {
    await fixture.close();
  }
});

it('persists owner logo changes for members while preserving the name lock and tenant boundary', async () => {
  const fixture = createDatabaseFixture();
  const { client, service, admin, owner, member, stranger, organizationIds } = fixture;
  try {
    await client.user.createMany({ data: [admin, owner, member, stranger] });
    await service.execute(admin.id, {
      kind: OrganizationAction.CREATE_ORGANIZATION,
      ownerEmail: owner.email,
    });
    const organization = await client.organization.findFirstOrThrow({
      where: { ownerUserId: owner.id },
    });
    organizationIds.push(organization.id);
    await service.execute(owner.id, {
      kind: OrganizationAction.SET_NAME,
      organizationId: organization.id,
      name: 'Permanent school',
    });
    await client.organizationMembership.create({
      data: { organizationId: organization.id, userId: member.id, role: AccountRole.STUDENT },
    });
    const command = {
      kind: OrganizationAction.SET_LOGO,
      organizationId: organization.id,
      logoDataUrl: organizationLogo,
    };
    for (const account of [admin, member, stranger]) {
      await expect(service.execute(account.id, command)).rejects.toEqual(
        new OrganizationError(OrganizationFailure.FORBIDDEN),
      );
    }
    await service.execute(owner.id, command);
    const memberHome = await service.execute(member.id, { kind: OrganizationAction.HOME });
    expect(memberHome).toMatchObject({ organizations: [{ name: 'Permanent school' }] });
    if (memberHome.kind !== 'home') {
      throw new Error('Missing member organization home');
    }
    expect(memberHome.organizations[0]?.logoDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(await service.execute(stranger.id, { kind: OrganizationAction.HOME })).toMatchObject({
      organizations: [],
    });
    await service.execute(admin.id, {
      kind: OrganizationAction.GRANT_OWNER,
      organizationId: organization.id,
      email: member.email,
    });
    await expect(service.execute(owner.id, command)).rejects.toEqual(
      new OrganizationError(OrganizationFailure.FORBIDDEN),
    );
    await service.execute(member.id, { ...command, logoDataUrl: null });
    const saved = await client.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(saved.logoDataUrl).toBeNull();
    expect(saved.name).toBe('Permanent school');
    expect(saved.nameSetAt).not.toBeNull();
  } finally {
    await fixture.close();
  }
});

it('approves owner creation, persists personal choices and applies direct email membership once under concurrency', async () => {
  const fixture = createDatabaseFixture();
  const { client, service, admin, owner, member, stranger, organizationIds } = fixture;
  try {
    await client.user.createMany({
      data: [admin, owner, { ...member, emailVerified: false }, stranger],
    });
    await service.execute(admin.id, { kind: OrganizationAction.APPROVE_OWNER, email: owner.email });
    await service.execute(owner.id, { kind: OrganizationAction.CONTINUE_PERSONAL });
    expect(await service.execute(owner.id, { kind: OrganizationAction.HOME })).toMatchObject({
      organizations: [],
      canCreateOrganization: true,
      hasChosenOrganization: true,
    });
    await service.execute(owner.id, {
      kind: OrganizationAction.CREATE_OWN_ORGANIZATION,
      name: 'Direct team',
    });
    const organization = await client.organization.findFirstOrThrow({
      where: { ownerUserId: owner.id },
    });
    organizationIds.push(organization.id);
    expect(organization.nameSetAt).not.toBeNull();
    await service.execute(owner.id, {
      kind: OrganizationAction.ADD_MEMBER,
      organizationId: organization.id,
      email: member.email,
      role: AccountRole.STUDENT,
    });
    expect(
      await client.organizationEmailMember.count({ where: { organizationId: organization.id } }),
    ).toBe(1);
    await service.execute(member.id, { kind: OrganizationAction.HOME });
    expect(
      await client.organizationMembership.count({
        where: { organizationId: organization.id, userId: member.id },
      }),
    ).toBe(0);
    await service.execute(owner.id, {
      kind: OrganizationAction.CHANGE_EMAIL_ROLE,
      organizationId: organization.id,
      email: member.email,
      role: AccountRole.TEACHER,
    });
    await client.user.update({ where: { id: member.id }, data: { emailVerified: true } });
    const homes = await Promise.all([
      service.execute(member.id, { kind: OrganizationAction.HOME }),
      service.execute(member.id, { kind: OrganizationAction.HOME }),
    ]);
    for (const home of homes) {
      expect(home).toMatchObject({
        organizations: [{ id: organization.id, role: AccountRole.TEACHER }],
        hasChosenOrganization: true,
      });
    }
    expect(
      await client.organizationMembership.count({
        where: { organizationId: organization.id, userId: member.id },
      }),
    ).toBe(1);
    expect(
      await client.organizationEmailMember.count({ where: { organizationId: organization.id } }),
    ).toBe(0);
    await service.execute(owner.id, {
      kind: OrganizationAction.ADD_MEMBER,
      organizationId: organization.id,
      email: stranger.email,
      role: AccountRole.STUDENT,
    });
    expect(await service.execute(stranger.id, { kind: OrganizationAction.HOME })).toMatchObject({
      organizations: [{ role: AccountRole.STUDENT }],
    });
    expect(
      await client.classroomEnrollment.count({
        where: { studentId: { in: [member.id, stranger.id] } },
      }),
    ).toBe(0);
    expect((await client.user.findUniqueOrThrow({ where: { id: owner.id } })).isAdmin).toBe(false);
    const count = await client.organization.count({ where: { ownerUserId: owner.id } });
    await service.execute(owner.id, {
      kind: OrganizationAction.CREATE_OWN_ORGANIZATION,
      name: 'Direct team',
    });
    expect(await client.organization.count({ where: { ownerUserId: owner.id } })).toBe(count);
  } finally {
    await fixture.close();
  }
});
