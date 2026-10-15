import { readAdminOrganizationId } from '../auth/AdminOrganizationContext.js';
import { AccountRole, AccountRoleSchema } from '#contracts/AccountRole.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Scoped classrooms use current membership; legacy classrooms retain account roles. */
export async function readClassroomRole(
  client: Prisma.TransactionClient,
  userId: string,
  organizationId: string | null,
): Promise<AccountRole | null> {
  const adminOrganizationId = readAdminOrganizationId(userId);
  if (adminOrganizationId !== null) {
    const actor = await client.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });
    return actor?.isAdmin && adminOrganizationId === organizationId ? AccountRole.TEACHER : null;
  }
  if (organizationId === null) {
    const user = await client.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user ? AccountRoleSchema.parse(user.role) : null;
  }
  const membership = await client.organizationMembership.findFirst({
    where: { userId, organizationId, removedAt: null },
    select: { role: true },
  });
  return membership ? AccountRoleSchema.parse(membership.role) : null;
}

/** Returns only currently authorized assigned teachers, never all teachers in an organization. */
export async function readAuthorizedClassTeacherIds(
  client: Prisma.TransactionClient,
  classId: string,
): Promise<string[]> {
  const schoolClass = await client.classroomGroup.findFirst({
    where: { id: classId, deletedAt: null },
    select: { teacherId: true, organizationId: true, teachers: { select: { userId: true } } },
  });
  if (!schoolClass) {
    return [];
  }
  if (schoolClass.organizationId === null) {
    return (await readClassroomRole(client, schoolClass.teacherId, null)) === AccountRole.TEACHER
      ? [schoolClass.teacherId]
      : [];
  }
  const memberships = await client.organizationMembership.findMany({
    where: {
      organizationId: schoolClass.organizationId,
      userId: { in: schoolClass.teachers.map((teacher) => teacher.userId) },
      role: AccountRole.TEACHER,
      removedAt: null,
    },
    select: { userId: true },
    orderBy: { userId: 'asc' },
  });
  return memberships.map((member) => member.userId);
}

/** A class assignment and the current organization role are both required. */
export async function canTeachClassroom(
  client: Prisma.TransactionClient,
  userId: string,
  classId: string,
): Promise<boolean> {
  const schoolClass = await client.classroomGroup.findFirst({
    where: { id: classId, deletedAt: null },
    select: {
      organizationId: true,
      teacherId: true,
      teachers: { where: { userId }, select: { userId: true }, take: 1 },
    },
  });
  if (readAdminOrganizationId(userId) !== null) {
    return (
      schoolClass !== null &&
      (await readClassroomRole(client, userId, schoolClass.organizationId)) === AccountRole.TEACHER
    );
  }
  if (
    !schoolClass ||
    (schoolClass.organizationId === null
      ? schoolClass.teacherId !== userId
      : schoolClass.teachers.length === 0)
  ) {
    return false;
  }
  return (
    (await readClassroomRole(client, userId, schoolClass.organizationId)) === AccountRole.TEACHER
  );
}
