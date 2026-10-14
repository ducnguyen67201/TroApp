import { PrismaPg } from '@prisma/adapter-pg';
import { ClassroomStatus } from '#contracts/Classroom.js';
import { AccountRoleSchema } from '#contracts/AccountRole.js';
import {
  OrganizationFailure,
  OrganizationClassSchema,
  OrganizationEmailMemberSchema,
  OrganizationInvitationSchema,
  OrganizationLimits,
  OrganizationMemberSchema,
  OrganizationSchema,
  OrganizationSummarySchema,
  type Organization,
  type OrganizationClass,
} from '#contracts/Organizations.js';
import { PrismaClient, Prisma } from '../generated/prisma/client.js';
import type {
  OrganizationAccount,
  OrganizationMembership,
  OrganizationStore,
  StoredOrganizationClass,
  StoredOrganizationInvitation,
  StoredOrganizationEmailMember,
} from '../features/organizations/application/OrganizationStore.js';
import { OrganizationError } from '../features/organizations/domain/OrganizationError.js';
import { runClassroomTransactionWithRetries } from './RetryClassroomTransaction.js';

const OrganizationAccountSelection = {
  id: true,
  email: true,
  emailVerified: true,
  role: true,
  isAdmin: true,
  canCreateOrganization: true,
  hasChosenOrganization: true,
} satisfies Prisma.UserSelect;

/** Prisma stays behind the organization port; callers cannot escape the transaction snapshot. */
class PrismaOrganizationStore implements OrganizationStore {
  constructor(
    private readonly client: Prisma.TransactionClient,
    private readonly runTransaction?: OrganizationStore['runAtomically'],
  ) {}

  runAtomically<T>(operation: (store: OrganizationStore) => Promise<T>): Promise<T> {
    return this.runTransaction ? this.runTransaction(operation) : operation(this);
  }

  listClasses(organizationId: string): Promise<OrganizationClass[]> {
    return this.listClassesMatching({ organizationId, deletedAt: null });
  }

  listPersonalClasses(userId: string): Promise<OrganizationClass[]> {
    return this.listClassesMatching({ organizationId: null, teacherId: userId, deletedAt: null });
  }

  private async listClassesMatching(
    where: Prisma.ClassroomGroupWhereInput,
  ): Promise<OrganizationClass[]> {
    const rows = await this.client.classroomGroup.findMany({
      where,
      include: {
        teachers: { select: { userId: true }, orderBy: { userId: 'asc' } },
        meetings: { where: { status: ClassroomStatus.LIVE }, select: { id: true }, take: 1 },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: OrganizationLimits.CLASSES,
    });
    return rows.map((row) =>
      OrganizationClassSchema.parse({
        id: row.id,
        name: row.name,
        teacherId: row.teacherId,
        teacherIds: row.teachers.map((teacher) => teacher.userId),
        hasLiveSession: row.meetings.length > 0,
      }),
    );
  }

  async readClass(classId: string): Promise<StoredOrganizationClass | null> {
    const row = await this.client.classroomGroup.findFirst({
      where: { id: classId, deletedAt: null },
      include: {
        teachers: { select: { userId: true }, orderBy: { userId: 'asc' } },
        meetings: { where: { status: ClassroomStatus.LIVE }, select: { id: true }, take: 1 },
        enrollments: { where: { active: true }, select: { studentId: true } },
        courseRevision: {
          select: { organizationId: true, classes: { select: { id: true }, take: 2 } },
        },
      },
    });
    return row
      ? {
          ...OrganizationClassSchema.parse({
            id: row.id,
            name: row.name,
            teacherId: row.teacherId,
            teacherIds: row.teachers.map((teacher) => teacher.userId),
            hasLiveSession: row.meetings.length > 0,
          }),
          organizationId: row.organizationId,
          courseRevisionId: row.courseRevisionId,
          canLinkCourse:
            row.courseRevision.organizationId === null && row.courseRevision.classes.length === 1,
          enrolledUserIds: row.enrollments.map((enrollment) => enrollment.studentId),
        }
      : null;
  }

  async saveClassTeachers(classId: string, teacherIds: readonly string[]): Promise<void> {
    const teacherId = teacherIds[0];
    if (!teacherId) {
      throw new OrganizationError(OrganizationFailure.INVALID);
    }
    await this.client.classTeacherAssignment.deleteMany({ where: { classId } });
    await this.client.classTeacherAssignment.createMany({
      data: teacherIds.map((userId) => ({ classId, userId })),
    });
    /* Keep the legacy primary-teacher field usable by older clients and admin summaries. */
    await this.client.classroomGroup.update({ where: { id: classId }, data: { teacherId } });
    await this.client.classroomInvitation.updateMany({
      where: { classId },
      data: { revoked: true },
    });
  }

  async linkClass(
    classId: string,
    courseRevisionId: string,
    organizationId: string,
  ): Promise<void> {
    await this.client.classroomGroup.update({ where: { id: classId }, data: { organizationId } });
    await this.client.classroomCourseRevision.update({
      where: { id: courseRevisionId },
      data: { organizationId },
    });
    await this.client.classroomInvitation.updateMany({
      where: { classId },
      data: { revoked: true },
    });
    await this.client.studentAdmission.updateMany({ where: { classId }, data: { revoked: true } });
    await this.client.studentDevice.updateMany({ where: { classId }, data: { revoked: true } });
  }

  async saveOwnerApproval(userId: string, approved: boolean): Promise<void> {
    await this.client.user.update({
      where: { id: userId },
      data: { canCreateOrganization: approved },
    });
  }

  async saveOrganizationChoice(userId: string, chosen: boolean): Promise<void> {
    await this.client.user.update({
      where: { id: userId },
      data: { hasChosenOrganization: chosen },
    });
  }

  async readEmailMember(
    organizationId: string,
    email: string,
  ): Promise<StoredOrganizationEmailMember | null> {
    const row = await this.client.organizationEmailMember.findUnique({
      where: { organizationId_email: { organizationId, email } },
    });
    return row ? { ...row, role: AccountRoleSchema.parse(row.role) } : null;
  }

  async listEmailMemberships(email: string): Promise<StoredOrganizationEmailMember[]> {
    const rows = await this.client.organizationEmailMember.findMany({
      where: { email },
      orderBy: { addedAt: 'asc' },
      take: OrganizationLimits.ORGANIZATIONS,
    });
    return rows.map((row) => ({ ...row, role: AccountRoleSchema.parse(row.role) }));
  }

  async listEmailMembers(organizationId: string) {
    const rows = await this.client.organizationEmailMember.findMany({
      where: { organizationId },
      orderBy: [{ addedAt: 'asc' }, { email: 'asc' }],
      take: OrganizationLimits.MEMBERS,
    });
    return rows.map((row) =>
      OrganizationEmailMemberSchema.parse({
        email: row.email,
        role: row.role,
        addedAt: row.addedAt.toISOString(),
      }),
    );
  }

  countEmailMembers(organizationId: string): Promise<number> {
    return this.client.organizationEmailMember.count({ where: { organizationId } });
  }

  async saveEmailMember(member: StoredOrganizationEmailMember): Promise<void> {
    const { organizationId, email, role } = member;
    await this.client.organizationEmailMember.upsert({
      where: { organizationId_email: { organizationId, email } },
      create: member,
      update: { role },
    });
  }

  async removeEmailMember(organizationId: string, email: string): Promise<void> {
    await this.client.organizationEmailMember.deleteMany({ where: { organizationId, email } });
  }

  async readAccount(userId: string): Promise<OrganizationAccount | null> {
    const row = await this.client.user.findUnique({
      where: { id: userId },
      select: OrganizationAccountSelection,
    });
    return row ? { ...row, role: AccountRoleSchema.parse(row.role) } : null;
  }

  async readVerifiedAccountByEmail(email: string): Promise<OrganizationAccount | null> {
    const rows = await this.client.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, emailVerified: true },
      select: OrganizationAccountSelection,
      take: 2,
    });
    /* Historical case-sensitive uniqueness can admit ambiguous verified email matches. */
    const row = rows.length === 1 ? rows[0] : undefined;
    return row ? { ...row, role: AccountRoleSchema.parse(row.role) } : null;
  }

  async readOrganization(organizationId: string): Promise<Organization | null> {
    const row = await this.client.organization.findUnique({
      where: { id: organizationId },
    });
    return row
      ? OrganizationSchema.parse({
          id: row.id,
          name: row.name,
          logoDataUrl: row.logoDataUrl,
          ownerUserId: row.ownerUserId,
          isNameSet: row.nameSetAt !== null,
        })
      : null;
  }

  async listOrganizations(account: OrganizationAccount) {
    const rows = await this.client.organization.findMany({
      where: account.isAdmin
        ? {}
        : { memberships: { some: { userId: account.id, removedAt: null } } },
      include: {
        memberships: { where: { userId: account.id, removedAt: null }, take: 1 },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: OrganizationLimits.ORGANIZATIONS,
    });
    return rows.map((row) =>
      OrganizationSummarySchema.parse({
        id: row.id,
        name: row.name,
        logoDataUrl: row.logoDataUrl,
        isNameSet: row.nameSetAt !== null,
        ownerUserId: row.ownerUserId,
        role: row.memberships[0]?.role ?? null,
        isOwner: row.ownerUserId === account.id,
      }),
    );
  }

  async createOrganization(organization: Organization): Promise<void> {
    const { isNameSet, logoDataUrl, ...data } = organization;
    await this.client.organization.create({
      data: {
        ...data,
        logoDataUrl: logoDataUrl ?? null,
        nameSetAt: isNameSet === false ? null : new Date(),
      },
    });
  }

  /** The conditional write also protects against competing first-login submissions. */
  async setOrganizationName(organizationId: string, name: string, now: Date): Promise<void> {
    const saved = await this.client.organization.updateMany({
      where: { id: organizationId, nameSetAt: null },
      data: { name, nameSetAt: now },
    });
    if (saved.count !== 1) {
      throw new OrganizationError(OrganizationFailure.CONFLICT);
    }
  }

  async saveOrganizationLogo(organizationId: string, logoDataUrl: string | null): Promise<void> {
    await this.client.organization.update({ where: { id: organizationId }, data: { logoDataUrl } });
  }

  async grantOwner(organizationId: string, userId: string): Promise<void> {
    await this.client.organization.update({
      where: { id: organizationId },
      data: { ownerUserId: userId },
    });
  }

  async readMembership(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | null> {
    const row = await this.client.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    return row ? { ...row, role: AccountRoleSchema.parse(row.role) } : null;
  }

  async saveMembership(membership: OrganizationMembership): Promise<void> {
    const { organizationId, userId, role, joinedAt, removedAt } = membership;
    await this.client.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      create: membership,
      update: { role, joinedAt, removedAt },
    });
  }

  async listMembers(organizationId: string) {
    const rows = await this.client.organizationMembership.findMany({
      where: { organizationId, removedAt: null },
      include: { user: { select: { name: true, email: true } } },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
      take: OrganizationLimits.MEMBERS,
    });
    return rows.map((row) =>
      OrganizationMemberSchema.parse({
        userId: row.userId,
        name: row.user.name,
        email: row.user.email?.toLowerCase() ?? null,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
      }),
    );
  }

  countMembers(organizationId: string): Promise<number> {
    return this.client.organizationMembership.count({
      where: { organizationId, removedAt: null },
    });
  }

  countOrganizations(userId: string): Promise<number> {
    return this.client.organizationMembership.count({ where: { userId, removedAt: null } });
  }

  countAllOrganizations(): Promise<number> {
    return this.client.organization.count();
  }

  async removeMember(organizationId: string, userId: string, removedAt: Date): Promise<void> {
    await this.client.organizationMembership.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { removedAt },
    });
    /* Historical work remains; joining the organization again requires a new class enrollment. */
    await this.client.classroomEnrollment.updateMany({
      where: { studentId: userId, schoolClass: { organizationId }, active: true },
      data: { active: false },
    });
    await this.client.classroomParticipation.updateMany({
      where: { studentId: userId, meeting: { schoolClass: { organizationId } }, left: false },
      data: { left: true },
    });
  }

  async listInvitations(organizationId: string, now: Date) {
    const rows = await this.client.organizationInvitation.findMany({
      where: { organizationId, revokedAt: null, acceptedAt: null, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: OrganizationLimits.INVITATIONS,
    });
    return rows.map((row) =>
      OrganizationInvitationSchema.parse({
        id: row.id,
        email: row.email,
        role: row.role,
        expiresAt: row.expiresAt.toISOString(),
      }),
    );
  }

  countInvitations(organizationId: string, now: Date): Promise<number> {
    return this.client.organizationInvitation.count({
      where: { organizationId, revokedAt: null, acceptedAt: null, expiresAt: { gt: now } },
    });
  }

  async readInvitation(invitationId: string): Promise<StoredOrganizationInvitation | null> {
    const row = await this.client.organizationInvitation.findUnique({
      where: { id: invitationId },
    });
    return row ? { ...row, role: AccountRoleSchema.parse(row.role) } : null;
  }

  async readInvitationByDigest(codeDigest: string): Promise<StoredOrganizationInvitation | null> {
    const row = await this.client.organizationInvitation.findUnique({ where: { codeDigest } });
    return row ? { ...row, role: AccountRoleSchema.parse(row.role) } : null;
  }

  async saveInvitation(invitation: StoredOrganizationInvitation): Promise<void> {
    await this.client.organizationInvitation.create({ data: invitation });
  }

  async revokeInvitations(organizationId: string, email: string, now: Date): Promise<void> {
    await this.client.organizationInvitation.updateMany({
      where: { organizationId, email, revokedAt: null, acceptedAt: null },
      data: { revokedAt: now },
    });
  }

  async revokeInvitation(invitationId: string, now: Date): Promise<void> {
    await this.client.organizationInvitation.update({
      where: { id: invitationId },
      data: { revokedAt: now },
    });
  }

  async acceptInvitation(invitationId: string, now: Date): Promise<void> {
    await this.client.organizationInvitation.update({
      where: { id: invitationId },
      data: { acceptedAt: now },
    });
  }
}

export function createPrismaOrganizationStore(connectionString: string): {
  store: OrganizationStore;
  close: () => Promise<void>;
} {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const store = new PrismaOrganizationStore(client, (operation) =>
    runClassroomTransactionWithRetries(
      () =>
        client.$transaction((transaction) => operation(new PrismaOrganizationStore(transaction)), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      { operation: 'organization.command' },
      { createExhaustionError: () => new OrganizationError(OrganizationFailure.UNAVAILABLE) },
    ),
  );
  return { store, close: () => client.$disconnect() };
}
