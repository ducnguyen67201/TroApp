import { readAdminOrganizationId } from '../auth/AdminOrganizationContext.js';
import { randomUUID } from 'node:crypto';
import { AccountRole } from '#contracts/AccountRole.js';
import { OrganizationLimits } from '#contracts/Organizations.js';
import {
  OrganizationComputerLimits,
  StudentAccessKind,
  type StudentAccessReply,
  type StudentEnrollment,
} from '#contracts/StudentAccess.js';
import type { Prisma, Organization } from '../generated/prisma/client.js';
import { StudentAccessError } from '../features/studentAccess/application/StudentAccessStore.js';

/** Current owners and verified platform admins authorize computers; students never grant device access. */
export async function requireOrganizationComputerAdmin(
  client: Prisma.TransactionClient,
  actorId: string,
  organizationId: string,
): Promise<Organization> {
  const organization = await client.organization.findUnique({ where: { id: organizationId } });
  const actor = await client.user.findUnique({ where: { id: actorId } });
  const membership = await client.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId: actorId } },
  });
  if (
    (readAdminOrganizationId(actorId) !== null &&
      readAdminOrganizationId(actorId) !== organizationId) ||
    !organization ||
    organization.nameSetAt === null ||
    !actor?.emailVerified ||
    (!actor.isAdmin &&
      (organization.ownerUserId !== actorId || !membership || membership.removedAt !== null))
  ) {
    throw new StudentAccessError(
      'Only the organization owner or an administrator can authorize computers.',
    );
  }
  return organization;
}

/** The unique organization/card key never matches or merges legacy class or Google accounts. */
export async function findOrCreateOrganizationStudent(
  client: Prisma.TransactionClient,
  organizationId: string,
  command: StudentEnrollment,
): Promise<{ userId: string; created: boolean }> {
  const profile = await client.studentLearnerProfile.findUnique({
    where: {
      organizationId_source_externalId: {
        organizationId,
        source: 'school-card',
        externalId: command.externalId,
      },
    },
  });
  if (profile) {
    return { userId: profile.userId, created: false };
  }
  if (!command.name) {
    throw new StudentAccessError('Enter your name for your first sign-in.');
  }
  const members = await client.organizationMembership.count({
    where: { organizationId, removedAt: null },
  });
  const reserved = await client.organizationEmailMember.count({ where: { organizationId } });
  if (members + reserved >= OrganizationLimits.MEMBERS) {
    throw new StudentAccessError(
      'The organization has reached its student allowance. Ask your administrator.',
    );
  }
  const userId = randomUUID();
  await client.user.create({
    data: {
      id: userId,
      name: command.name,
      email: null,
      role: AccountRole.STUDENT,
      hasChosenOrganization: true,
      learnerProfile: {
        create: { schoolId: organizationId, organizationId, externalId: command.externalId },
      },
      organizationMemberships: { create: { organizationId, role: AccountRole.STUDENT } },
    },
  });
  return { userId, created: true };
}

/** Counts persisted identities and successful new sign-in operations, never camera scans or retry polls. */
export async function readOrganizationComputerUsage(
  client: Prisma.TransactionClient,
  actorId: string,
  organizationId: string,
  now: Date,
): Promise<StudentAccessReply> {
  await requireOrganizationComputerAdmin(client, actorId, organizationId);
  const computers = await client.studentDevice.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take: OrganizationComputerLimits.COMPUTERS,
  });
  const deviceIds = computers.map((computer) => computer.id);
  const day = now.toISOString().slice(0, 10);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const sessionsToday = { deviceId: { in: deviceIds }, createdAt: { gte: dayStart } };
  const registeredStudents = await client.studentLearnerProfile.count({
    where: { organizationId },
  });
  const studentsToday = await client.studentLearnerSession.groupBy({
    by: ['userId'],
    where: sessionsToday,
  });
  const signInsToday = await client.studentLearnerSession.count({ where: sessionsToday });
  const totalSignIns = await client.studentLearnerSession.count({
    where: { deviceId: { in: deviceIds } },
  });
  const activationCodes = await client.studentAdmission.findMany({
    where: { organizationId, revoked: false, expiresAt: { gt: now } },
    orderBy: { expiresAt: 'desc' },
    take: OrganizationComputerLimits.ACTIVE_CODES,
  });
  return {
    kind: StudentAccessKind.ORGANIZATION_ACCESS,
    organizationId,
    day,
    authorizedComputers: computers.filter(
      (computer) => !computer.revoked && computer.expiresAt > now,
    ).length,
    registeredStudents,
    studentsToday: studentsToday.length,
    signInsToday,
    totalSignIns,
    computers: computers.map((computer) => ({
      id: computer.id,
      name: computer.computerName ?? '',
      createdAt: computer.createdAt.toISOString(),
      lastSignInAt: computer.lastSignInAt?.toISOString() ?? null,
      expiresAt: computer.expiresAt.toISOString(),
      revoked: computer.revoked,
    })),
    activationCodes: activationCodes.map((code) => ({
      id: code.id,
      activations: code.uses,
      expiresAt: code.expiresAt.toISOString(),
    })),
  };
}
