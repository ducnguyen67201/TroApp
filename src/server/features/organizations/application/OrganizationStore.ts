import type { AccountRole } from '#contracts/AccountRole.js';
import type {
  Organization,
  OrganizationClass,
  OrganizationEmailMember,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationSummary,
} from '#contracts/Organizations.js';

export interface OrganizationAccount {
  id: string;
  email: string;
  emailVerified: boolean;
  role: AccountRole;
  isAdmin: boolean;
  canCreateOrganization?: boolean;
  hasChosenOrganization?: boolean;
}

export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: AccountRole;
  joinedAt: Date;
  removedAt: Date | null;
}

export interface StoredOrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: AccountRole;
  codeDigest: string;
  invitedByUserId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface StoredOrganizationEmailMember {
  organizationId: string;
  email: string;
  role: AccountRole;
  addedAt: Date;
}

export interface StoredOrganizationClass extends OrganizationClass {
  organizationId: string | null;
  courseRevisionId: string;
  canLinkCourse: boolean;
  enrolledUserIds: string[];
}

/** Every authorization check and corresponding write uses the same serializable transaction. */
export interface OrganizationStore {
  runAtomically<T>(operation: (store: OrganizationStore) => Promise<T>): Promise<T>;
  listClasses(organizationId: string): Promise<OrganizationClass[]>;
  listPersonalClasses(userId: string): Promise<OrganizationClass[]>;
  readClass(classId: string): Promise<StoredOrganizationClass | null>;
  saveClassTeachers(classId: string, teacherIds: readonly string[]): Promise<void>;
  linkClass(classId: string, courseRevisionId: string, organizationId: string): Promise<void>;
  saveOwnerApproval(userId: string, approved: boolean): Promise<void>;
  saveOrganizationChoice(userId: string, chosen: boolean): Promise<void>;
  readEmailMember(
    organizationId: string,
    email: string,
  ): Promise<StoredOrganizationEmailMember | null>;
  listEmailMemberships(email: string): Promise<StoredOrganizationEmailMember[]>;
  listEmailMembers(organizationId: string): Promise<OrganizationEmailMember[]>;
  countEmailMembers(organizationId: string): Promise<number>;
  saveEmailMember(member: StoredOrganizationEmailMember): Promise<void>;
  removeEmailMember(organizationId: string, email: string): Promise<void>;
  readAccount(userId: string): Promise<OrganizationAccount | null>;
  readVerifiedAccountByEmail(email: string): Promise<OrganizationAccount | null>;
  readOrganization(organizationId: string): Promise<Organization | null>;
  listOrganizations(account: OrganizationAccount): Promise<OrganizationSummary[]>;
  createOrganization(organization: Organization): Promise<void>;
  setOrganizationName(organizationId: string, name: string, now: Date): Promise<void>;
  saveOrganizationLogo(organizationId: string, logoDataUrl: string | null): Promise<void>;
  grantOwner(organizationId: string, userId: string): Promise<void>;
  readMembership(organizationId: string, userId: string): Promise<OrganizationMembership | null>;
  saveMembership(membership: OrganizationMembership): Promise<void>;
  listMembers(organizationId: string): Promise<OrganizationMember[]>;
  countMembers(organizationId: string): Promise<number>;
  countOrganizations(userId: string): Promise<number>;
  countAllOrganizations(): Promise<number>;
  removeMember(organizationId: string, userId: string, removedAt: Date): Promise<void>;
  listInvitations(organizationId: string, now: Date): Promise<OrganizationInvitation[]>;
  countInvitations(organizationId: string, now: Date): Promise<number>;
  readInvitation(invitationId: string): Promise<StoredOrganizationInvitation | null>;
  readInvitationByDigest(codeDigest: string): Promise<StoredOrganizationInvitation | null>;
  saveInvitation(invitation: StoredOrganizationInvitation): Promise<void>;
  revokeInvitations(organizationId: string, email: string, now: Date): Promise<void>;
  revokeInvitation(invitationId: string, now: Date): Promise<void>;
  acceptInvitation(invitationId: string, now: Date): Promise<void>;
}
