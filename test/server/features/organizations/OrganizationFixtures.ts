import { randomUUID } from 'node:crypto';
import { AccountRole } from '#contracts/AccountRole.js';
import type {
  Organization,
  OrganizationClass,
  OrganizationEmailMember,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationSummary,
} from '#contracts/Organizations.js';
import type {
  OrganizationAccount,
  OrganizationMembership,
  OrganizationStore,
  StoredOrganizationClass,
  StoredOrganizationInvitation,
  StoredOrganizationEmailMember,
} from '../../../../src/server/features/organizations/application/OrganizationStore.js';
import { OrganizationFailure } from '#contracts/Organizations.js';
import { OrganizationError } from '../../../../src/server/features/organizations/domain/OrganizationError.js';
import { OrganizationService } from '../../../../src/server/features/organizations/application/OrganizationService.js';

export class MemoryOrganizationStore implements OrganizationStore {
  readonly classes = new Map<string, StoredOrganizationClass>();
  readonly emailMembers = new Map<string, StoredOrganizationEmailMember>();
  readonly accounts = new Map<string, OrganizationAccount>();
  readonly organizations = new Map<string, Organization>();
  readonly memberships = new Map<string, OrganizationMembership>();
  readonly invitations = new Map<string, StoredOrganizationInvitation>();

  runAtomically<T>(operation: (store: OrganizationStore) => Promise<T>): Promise<T> {
    return operation(this);
  }

  listClasses(organizationId: string): Promise<OrganizationClass[]> {
    return Promise.resolve(
      [...this.classes.values()]
        .filter((item) => item.organizationId === organizationId)
        .map(({ id, name, teacherId, teacherIds, hasLiveSession }) => ({
          id,
          name,
          teacherId,
          ...(teacherIds ? { teacherIds } : {}),
          hasLiveSession,
        })),
    );
  }

  listPersonalClasses(userId: string): Promise<OrganizationClass[]> {
    return Promise.resolve(
      [...this.classes.values()]
        .filter((item) => item.organizationId === null && item.teacherId === userId)
        .map(({ id, name, teacherId, teacherIds, hasLiveSession }) => ({
          id,
          name,
          teacherId,
          ...(teacherIds ? { teacherIds } : {}),
          hasLiveSession,
        })),
    );
  }

  readClass(classId: string): Promise<StoredOrganizationClass | null> {
    return Promise.resolve(this.classes.get(classId) ?? null);
  }

  saveClassTeachers(classId: string, teacherIds: readonly string[]): Promise<void> {
    const teacherId = teacherIds[0];
    if (!teacherId) {
      throw new Error('Missing assigned teacher');
    }
    const item = this.classes.get(classId);
    if (item) {
      this.classes.set(classId, { ...item, teacherId, teacherIds: [...teacherIds] });
    }
    return Promise.resolve();
  }

  linkClass(classId: string, _courseRevisionId: string, organizationId: string): Promise<void> {
    const item = this.classes.get(classId);
    if (item) {
      this.classes.set(classId, { ...item, organizationId, canLinkCourse: false });
    }
    return Promise.resolve();
  }

  saveOwnerApproval(userId: string, approved: boolean): Promise<void> {
    const account = this.accounts.get(userId);
    if (account) {
      this.accounts.set(userId, { ...account, canCreateOrganization: approved });
    }
    return Promise.resolve();
  }

  saveOrganizationChoice(userId: string, chosen: boolean): Promise<void> {
    const account = this.accounts.get(userId);
    if (account) {
      this.accounts.set(userId, { ...account, hasChosenOrganization: chosen });
    }
    return Promise.resolve();
  }

  readEmailMember(
    organizationId: string,
    email: string,
  ): Promise<StoredOrganizationEmailMember | null> {
    return Promise.resolve(this.emailMembers.get(`${organizationId}/${email}`) ?? null);
  }

  listEmailMemberships(email: string): Promise<StoredOrganizationEmailMember[]> {
    return Promise.resolve(
      [...this.emailMembers.values()].filter((member) => member.email === email),
    );
  }

  listEmailMembers(organizationId: string): Promise<OrganizationEmailMember[]> {
    return Promise.resolve(
      [...this.emailMembers.values()]
        .filter((member) => member.organizationId === organizationId)
        .map(({ email, role, addedAt }) => ({ email, role, addedAt: addedAt.toISOString() })),
    );
  }

  countEmailMembers(organizationId: string): Promise<number> {
    return Promise.resolve(
      [...this.emailMembers.values()].filter((member) => member.organizationId === organizationId)
        .length,
    );
  }

  saveEmailMember(member: StoredOrganizationEmailMember): Promise<void> {
    this.emailMembers.set(`${member.organizationId}/${member.email}`, member);
    return Promise.resolve();
  }

  removeEmailMember(organizationId: string, email: string): Promise<void> {
    this.emailMembers.delete(`${organizationId}/${email}`);
    return Promise.resolve();
  }

  readAccount(userId: string): Promise<OrganizationAccount | null> {
    return Promise.resolve(this.accounts.get(userId) ?? null);
  }

  readVerifiedAccountByEmail(email: string): Promise<OrganizationAccount | null> {
    const matches = [...this.accounts.values()].filter(
      (account) => account.email?.toLowerCase() === email.toLowerCase() && account.emailVerified,
    );
    return Promise.resolve(matches.length === 1 ? (matches[0] ?? null) : null);
  }

  readOrganization(organizationId: string): Promise<Organization | null> {
    return Promise.resolve(this.organizations.get(organizationId) ?? null);
  }

  listOrganizations(account: OrganizationAccount): Promise<OrganizationSummary[]> {
    const organizations: OrganizationSummary[] = [];
    for (const organization of this.organizations.values()) {
      const membership = this.memberships.get(`${organization.id}/${account.id}`);
      if (account.isAdmin || (membership && membership.removedAt === null)) {
        organizations.push({
          ...organization,
          role: membership && membership.removedAt === null ? membership.role : null,
          isOwner: organization.ownerUserId === account.id,
        });
      }
    }
    return Promise.resolve(organizations);
  }

  createOrganization(organization: Organization): Promise<void> {
    this.organizations.set(organization.id, organization);
    return Promise.resolve();
  }

  setOrganizationName(organizationId: string, name: string): Promise<void> {
    const organization = this.organizations.get(organizationId);
    if (!organization || organization.isNameSet !== false) {
      return Promise.reject(new OrganizationError(OrganizationFailure.CONFLICT));
    }
    this.organizations.set(organizationId, { ...organization, name, isNameSet: true });
    return Promise.resolve();
  }

  saveOrganizationLogo(organizationId: string, logoDataUrl: string | null): Promise<void> {
    const organization = this.organizations.get(organizationId);
    if (organization) {
      this.organizations.set(organizationId, { ...organization, logoDataUrl });
    }
    return Promise.resolve();
  }

  grantOwner(organizationId: string, userId: string): Promise<void> {
    const organization = this.organizations.get(organizationId);
    if (organization) {
      this.organizations.set(organizationId, { ...organization, ownerUserId: userId });
    }
    return Promise.resolve();
  }

  readMembership(organizationId: string, userId: string): Promise<OrganizationMembership | null> {
    return Promise.resolve(this.memberships.get(`${organizationId}/${userId}`) ?? null);
  }

  saveMembership(membership: OrganizationMembership): Promise<void> {
    this.memberships.set(`${membership.organizationId}/${membership.userId}`, membership);
    return Promise.resolve();
  }

  listMembers(organizationId: string): Promise<OrganizationMember[]> {
    const members: OrganizationMember[] = [];
    for (const membership of this.memberships.values()) {
      const account = this.accounts.get(membership.userId);
      if (membership.organizationId === organizationId && !membership.removedAt && account) {
        members.push({
          userId: account.id,
          name: account.id,
          email: account.email,
          role: membership.role,
          joinedAt: membership.joinedAt.toISOString(),
        });
      }
    }
    return Promise.resolve(members);
  }

  countMembers(organizationId: string): Promise<number> {
    return Promise.resolve(
      [...this.memberships.values()].filter(
        (member) => member.organizationId === organizationId && member.removedAt === null,
      ).length,
    );
  }

  countOrganizations(userId: string): Promise<number> {
    return Promise.resolve(
      [...this.memberships.values()].filter(
        (member) => member.userId === userId && member.removedAt === null,
      ).length,
    );
  }

  countAllOrganizations(): Promise<number> {
    return Promise.resolve(this.organizations.size);
  }

  removeMember(organizationId: string, userId: string, removedAt: Date): Promise<void> {
    const membership = this.memberships.get(`${organizationId}/${userId}`);
    if (membership) {
      this.memberships.set(`${organizationId}/${userId}`, { ...membership, removedAt });
    }
    return Promise.resolve();
  }

  listInvitations(organizationId: string, now: Date): Promise<OrganizationInvitation[]> {
    return Promise.resolve(
      [...this.invitations.values()]
        .filter(
          (invitation) =>
            invitation.organizationId === organizationId &&
            invitation.acceptedAt === null &&
            invitation.revokedAt === null &&
            invitation.expiresAt > now,
        )
        .map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt.toISOString(),
        })),
    );
  }

  async countInvitations(organizationId: string, now: Date): Promise<number> {
    return (await this.listInvitations(organizationId, now)).length;
  }

  readInvitation(invitationId: string): Promise<StoredOrganizationInvitation | null> {
    return Promise.resolve(this.invitations.get(invitationId) ?? null);
  }

  readInvitationByDigest(codeDigest: string): Promise<StoredOrganizationInvitation | null> {
    return Promise.resolve(
      [...this.invitations.values()].find((invitation) => invitation.codeDigest === codeDigest) ??
        null,
    );
  }

  saveInvitation(invitation: StoredOrganizationInvitation): Promise<void> {
    this.invitations.set(invitation.id, invitation);
    return Promise.resolve();
  }

  revokeInvitations(organizationId: string, email: string, now: Date): Promise<void> {
    for (const invitation of this.invitations.values()) {
      if (
        invitation.organizationId === organizationId &&
        invitation.email === email &&
        invitation.acceptedAt === null &&
        invitation.revokedAt === null
      ) {
        this.invitations.set(invitation.id, { ...invitation, revokedAt: now });
      }
    }
    return Promise.resolve();
  }

  revokeInvitation(invitationId: string, now: Date): Promise<void> {
    const invitation = this.invitations.get(invitationId);
    if (invitation) {
      this.invitations.set(invitationId, { ...invitation, revokedAt: now });
    }
    return Promise.resolve();
  }

  acceptInvitation(invitationId: string, now: Date): Promise<void> {
    const invitation = this.invitations.get(invitationId);
    if (invitation) {
      this.invitations.set(invitationId, { ...invitation, acceptedAt: now });
    }
    return Promise.resolve();
  }
}

export async function createOrganizationFixture() {
  const store = new MemoryOrganizationStore();
  const now = new Date('2026-10-14T12:00:00.000Z');
  const admin = {
    id: 'admin',
    email: 'admin@example.test',
    emailVerified: true,
    role: AccountRole.STUDENT,
    isAdmin: true,
  } satisfies OrganizationAccount;
  const owner = {
    id: 'owner',
    email: 'owner@example.test',
    emailVerified: true,
    role: AccountRole.STUDENT,
    isAdmin: false,
  } satisfies OrganizationAccount;
  const member = {
    id: 'member',
    email: 'member@example.test',
    emailVerified: true,
    role: AccountRole.TEACHER,
    isAdmin: false,
  } satisfies OrganizationAccount;
  const stranger = {
    id: 'stranger',
    email: 'stranger@example.test',
    emailVerified: true,
    role: AccountRole.STUDENT,
    isAdmin: false,
  } satisfies OrganizationAccount;
  for (const account of [admin, owner, member, stranger]) {
    store.accounts.set(account.id, account);
  }
  const organization = { id: randomUUID(), name: 'Studio', ownerUserId: owner.id };
  await store.createOrganization(organization);
  await store.saveMembership({
    organizationId: organization.id,
    userId: owner.id,
    role: AccountRole.STUDENT,
    joinedAt: now,
    removedAt: null,
  });
  return {
    store,
    service: new OrganizationService(store, () => now),
    organization,
    admin,
    owner,
    member,
    stranger,
    now,
  };
}
