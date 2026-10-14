import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationFailure,
  OrganizationLimits,
  type Organization,
  type OrganizationCommand,
  type OrganizationReply,
} from '#contracts/Organizations.js';
import { OrganizationError } from '../domain/OrganizationError.js';
import { addOrganizationMember, applyEmailMemberships } from './DirectOrganizationMembers.js';
import {
  assignOrganizationClassTeacher,
  setOrganizationClassTeachers,
  linkPersonalClassToOrganization,
} from './OrganizationClassAssignments.js';
import { validateAndFormatOrganizationLogo } from './OrganizationLogo.js';
import type { OrganizationAccount, OrganizationStore } from './OrganizationStore.js';

/** Only persisted platform admins appoint owners; only the current owner manages the team. */
export class OrganizationService {
  constructor(
    private readonly store: OrganizationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  execute(userId: string, command: OrganizationCommand): Promise<OrganizationReply> {
    return this.store.runAtomically(async (store) => {
      const account = await store.readAccount(userId);
      if (!account) {
        throw new OrganizationError(OrganizationFailure.UNAUTHORIZED);
      }
      if (command.kind === OrganizationAction.HOME) {
        await applyEmailMemberships(store, account, this.now());
        const refreshed = (await store.readAccount(account.id)) ?? account;
        return {
          kind: 'home',
          organizations: await store.listOrganizations(account),
          isAdmin: account.isAdmin,
          ...(refreshed.hasChosenOrganization !== undefined
            ? {
                hasChosenOrganization: refreshed.hasChosenOrganization,
                canCreateOrganization:
                  refreshed.isAdmin || refreshed.canCreateOrganization === true,
              }
            : {}),
        };
      }
      if (command.kind === OrganizationAction.CONTINUE_PERSONAL) {
        await store.saveOrganizationChoice(account.id, true);
        return { kind: 'ok' };
      }
      if (command.kind === OrganizationAction.APPROVE_OWNER) {
        this.requireAdmin(account);
        const owner = await this.readVerifiedOwner(store, command.email);
        await store.saveOwnerApproval(owner.id, true);
        await store.saveOrganizationChoice(owner.id, false);
        return { kind: 'ok' };
      }
      if (command.kind === OrganizationAction.CREATE_OWN_ORGANIZATION) {
        const owned = (await store.listOrganizations(account)).find(
          (organization) => organization.isOwner,
        );
        if (owned) {
          if (owned.isNameSet !== false && owned.name === command.name) {
            return { kind: 'ok' };
          }
          throw new OrganizationError(OrganizationFailure.CONFLICT);
        }
        if ((!account.isAdmin && !account.canCreateOrganization) || !account.emailVerified) {
          throw new OrganizationError(OrganizationFailure.FORBIDDEN);
        }
        if ((await store.countAllOrganizations()) >= OrganizationLimits.ORGANIZATIONS) {
          throw new OrganizationError(OrganizationFailure.CONFLICT);
        }
        const organization = {
          id: randomUUID(),
          name: command.name,
          isNameSet: true,
          ownerUserId: account.id,
        };
        await store.createOrganization(organization);
        await this.addOwnerMembership(store, organization, account);
        await store.saveOwnerApproval(account.id, false);
        await store.saveOrganizationChoice(account.id, true);
        return { kind: 'ok' };
      }
      /* Older admins provisioned an unnamed organization before owner sign-in. */
      if (command.kind === OrganizationAction.CREATE_ORGANIZATION) {
        this.requireAdmin(account);
        if ((await store.countAllOrganizations()) >= OrganizationLimits.ORGANIZATIONS) {
          throw new OrganizationError(OrganizationFailure.CONFLICT);
        }
        const owner = await this.readVerifiedOwner(store, command.ownerEmail);
        await this.requireOrganizationCapacity(store, owner.id);
        const organization = {
          id: randomUUID(),
          name: command.name ?? 'Organization',
          isNameSet: false,
          ownerUserId: owner.id,
        };
        await store.createOrganization(organization);
        await this.addOwnerMembership(store, organization, owner);
        return { kind: 'ok' };
      }
      if (command.kind === OrganizationAction.ACCEPT_INVITATION) {
        return this.acceptLegacyInvitation(store, account, command.code);
      }
      if (command.kind === OrganizationAction.GRANT_OWNER) {
        this.requireAdmin(account);
        const organization = await this.readOrganization(store, command.organizationId);
        const owner = await this.readVerifiedOwner(store, command.email);
        await this.addOwnerMembership(store, organization, owner);
        await store.grantOwner(organization.id, owner.id);
        /* Outstanding invitations were issued under the former owner's authority. */
        for (const invitation of await store.listInvitations(organization.id, this.now())) {
          await store.revokeInvitation(invitation.id, this.now());
        }
        return { kind: 'ok' };
      }
      const organization = await this.requireOwner(store, account.id, command.organizationId);
      if (command.kind === OrganizationAction.TEAM) {
        return {
          kind: 'team',
          organization,
          members: await store.listMembers(organization.id),
          invitations: await store.listInvitations(organization.id, this.now()),
          emailMembers: await store.listEmailMembers(organization.id),
          classes: await store.listClasses(organization.id),
          personalClasses: await store.listPersonalClasses(account.id),
        };
      }
      /* The legacy rename command now has the same one-time setup restriction. */
      if (
        command.kind === OrganizationAction.SET_NAME ||
        command.kind === OrganizationAction.RENAME_ORGANIZATION
      ) {
        if (organization.isNameSet !== false) {
          throw new OrganizationError(OrganizationFailure.CONFLICT);
        }
        await store.setOrganizationName(organization.id, command.name, this.now());
        await store.saveOrganizationChoice(account.id, true);
        await store.saveOwnerApproval(account.id, false);
        return { kind: 'ok' };
      }
      if (organization.isNameSet === false) {
        throw new OrganizationError(OrganizationFailure.CONFLICT);
      }
      if (command.kind === OrganizationAction.SET_CLASS_TEACHERS) {
        await setOrganizationClassTeachers(store, command);
        return { kind: 'ok' };
      }
      if (command.kind === OrganizationAction.ASSIGN_CLASS_TEACHER) {
        await assignOrganizationClassTeacher(store, command);
        return { kind: 'ok' };
      }
      if (command.kind === OrganizationAction.LINK_CLASS) {
        await linkPersonalClassToOrganization(store, account.id, command);
        return { kind: 'ok' };
      }
      if (command.kind === OrganizationAction.SET_LOGO) {
        const logoDataUrl =
          command.logoDataUrl === null
            ? null
            : validateAndFormatOrganizationLogo(command.logoDataUrl);
        await store.saveOrganizationLogo(organization.id, logoDataUrl);
        return { kind: 'ok' };
      }
      if (command.kind === OrganizationAction.ADD_MEMBER) {
        await addOrganizationMember(
          store,
          organization.id,
          command.email,
          command.role,
          this.now(),
        );
        return { kind: 'ok' };
      }
      if (
        command.kind === OrganizationAction.CHANGE_EMAIL_ROLE ||
        command.kind === OrganizationAction.REMOVE_EMAIL_MEMBER
      ) {
        const addition = await store.readEmailMember(organization.id, command.email);
        if (!addition) {
          throw new OrganizationError(OrganizationFailure.NOT_FOUND);
        }
        if (command.kind === OrganizationAction.CHANGE_EMAIL_ROLE) {
          await store.saveEmailMember({ ...addition, role: command.role });
        } else {
          await store.removeEmailMember(organization.id, command.email);
          await store.revokeInvitations(organization.id, command.email, this.now());
        }
        return { kind: 'ok' };
      }
      if (command.kind === OrganizationAction.INVITE) {
        return this.createLegacyInvitation(store, account, organization, command);
      }
      if (command.kind === OrganizationAction.REVOKE_INVITATION) {
        const invitation = await store.readInvitation(command.invitationId);
        if (!invitation || invitation.organizationId !== organization.id) {
          throw new OrganizationError(OrganizationFailure.NOT_FOUND);
        }
        await store.revokeInvitation(invitation.id, this.now());
        return { kind: 'ok' };
      }
      const membership = await store.readMembership(organization.id, command.userId);
      if (!membership || membership.removedAt !== null) {
        throw new OrganizationError(OrganizationFailure.NOT_FOUND);
      }
      const memberAccount = await store.readAccount(command.userId);
      if (!memberAccount) {
        throw new OrganizationError(OrganizationFailure.NOT_FOUND);
      }
      const now = this.now();
      /* A stale invitation must never reverse a later role change or removal. */
      await store.revokeInvitations(organization.id, memberAccount.email.toLowerCase(), now);
      if (command.kind === OrganizationAction.CHANGE_ROLE) {
        await store.saveMembership({ ...membership, role: command.role });
        return { kind: 'ok' };
      }
      if (command.userId === organization.ownerUserId) {
        throw new OrganizationError(OrganizationFailure.CONFLICT);
      }
      await store.removeMember(organization.id, command.userId, now);
      return { kind: 'ok' };
    });
  }

  private requireAdmin(account: OrganizationAccount): void {
    if (!account.isAdmin) {
      throw new OrganizationError(OrganizationFailure.FORBIDDEN);
    }
  }

  private async readOrganization(
    store: OrganizationStore,
    organizationId: string,
  ): Promise<Organization> {
    const organization = await store.readOrganization(organizationId);
    if (!organization) {
      throw new OrganizationError(OrganizationFailure.NOT_FOUND);
    }
    return organization;
  }

  private async requireOwner(
    store: OrganizationStore,
    userId: string,
    organizationId: string,
  ): Promise<Organization> {
    const organization = await this.readOrganization(store, organizationId);
    const membership = await store.readMembership(organizationId, userId);
    if (organization.ownerUserId !== userId || !membership || membership.removedAt !== null) {
      throw new OrganizationError(OrganizationFailure.FORBIDDEN);
    }
    return organization;
  }

  private async readVerifiedOwner(
    store: OrganizationStore,
    email: string,
  ): Promise<OrganizationAccount> {
    const owner = await store.readVerifiedAccountByEmail(email);
    if (!owner) {
      throw new OrganizationError(OrganizationFailure.NOT_FOUND);
    }
    return owner;
  }

  private async addOwnerMembership(
    store: OrganizationStore,
    organization: Organization,
    owner: OrganizationAccount,
  ): Promise<void> {
    const membership = await store.readMembership(organization.id, owner.id);
    if (membership && membership.removedAt === null) {
      return;
    }
    await this.requireMemberCapacity(store, organization.id);
    await this.requireOrganizationCapacity(store, owner.id);
    await store.saveMembership({
      organizationId: organization.id,
      userId: owner.id,
      role: AccountRole.STUDENT,
      joinedAt: this.now(),
      removedAt: null,
    });
    await store.revokeInvitations(organization.id, owner.email.toLowerCase(), this.now());
  }

  private async requireMemberCapacity(
    store: OrganizationStore,
    organizationId: string,
  ): Promise<void> {
    if (
      (await store.countMembers(organizationId)) +
        (await store.countEmailMembers(organizationId)) >=
      OrganizationLimits.MEMBERS
    ) {
      throw new OrganizationError(OrganizationFailure.CONFLICT);
    }
  }

  private async requireOrganizationCapacity(
    store: OrganizationStore,
    userId: string,
  ): Promise<void> {
    if ((await store.countOrganizations(userId)) >= OrganizationLimits.ORGANIZATIONS) {
      throw new OrganizationError(OrganizationFailure.CONFLICT);
    }
  }

  /** Retains the versioned invitation API for older clients; current Team uses direct additions. */
  private async createLegacyInvitation(
    store: OrganizationStore,
    account: OrganizationAccount,
    organization: Organization,
    command: Extract<OrganizationCommand, { kind: typeof OrganizationAction.INVITE }>,
  ): Promise<OrganizationReply> {
    const memberAccount = await store.readVerifiedAccountByEmail(command.email);
    if (memberAccount) {
      const membership = await store.readMembership(organization.id, memberAccount.id);
      if (membership && membership.removedAt === null) {
        throw new OrganizationError(OrganizationFailure.CONFLICT);
      }
    }
    const now = this.now();
    await this.requireMemberCapacity(store, organization.id);
    await store.revokeInvitations(organization.id, command.email, now);
    if ((await store.countInvitations(organization.id, now)) >= OrganizationLimits.INVITATIONS) {
      throw new OrganizationError(OrganizationFailure.CONFLICT);
    }
    const code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + OrganizationLimits.INVITATION_LIFETIME_MS);
    await store.saveInvitation({
      id: randomUUID(),
      organizationId: organization.id,
      email: command.email,
      role: command.role,
      codeDigest: this.hashInvitationCode(code),
      invitedByUserId: account.id,
      expiresAt,
      acceptedAt: null,
      revokedAt: null,
    });
    return { kind: 'invitation', code, expiresAt: expiresAt.toISOString() };
  }

  private async acceptLegacyInvitation(
    store: OrganizationStore,
    account: OrganizationAccount,
    code: string,
  ): Promise<OrganizationReply> {
    const now = this.now();
    const invitation = await store.readInvitationByDigest(this.hashInvitationCode(code));
    if (
      !account.emailVerified ||
      !invitation ||
      invitation.email !== account.email.toLowerCase() ||
      invitation.revokedAt !== null ||
      invitation.acceptedAt !== null ||
      invitation.expiresAt.getTime() <= now.getTime()
    ) {
      throw new OrganizationError(OrganizationFailure.FORBIDDEN);
    }
    const organization = await this.readOrganization(store, invitation.organizationId);
    if (
      organization.isNameSet === false ||
      organization.ownerUserId !== invitation.invitedByUserId
    ) {
      throw new OrganizationError(OrganizationFailure.FORBIDDEN);
    }
    const inviter = await store.readMembership(organization.id, invitation.invitedByUserId);
    if (!inviter || inviter.removedAt !== null) {
      throw new OrganizationError(OrganizationFailure.FORBIDDEN);
    }
    const membership = await store.readMembership(organization.id, account.id);
    if (membership && membership.removedAt === null) {
      throw new OrganizationError(OrganizationFailure.CONFLICT);
    }
    await this.requireMemberCapacity(store, organization.id);
    await this.requireOrganizationCapacity(store, account.id);
    await store.saveMembership({
      organizationId: organization.id,
      userId: account.id,
      role: invitation.role,
      joinedAt: now,
      removedAt: null,
    });
    await store.acceptInvitation(invitation.id, now);
    await store.revokeInvitations(organization.id, account.email.toLowerCase(), now);
    return { kind: 'ok' };
  }

  private hashInvitationCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
