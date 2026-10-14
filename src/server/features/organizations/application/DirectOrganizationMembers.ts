import { OrganizationFailure, OrganizationLimits } from '#contracts/Organizations.js';
import type { AccountRole } from '#contracts/AccountRole.js';
import { OrganizationError } from '../domain/OrganizationError.js';
import type { OrganizationAccount, OrganizationStore } from './OrganizationStore.js';

/** Existing verified accounts join immediately; new emails reserve a team place until sign-in. */
export async function addOrganizationMember(
  store: OrganizationStore,
  organizationId: string,
  email: string,
  role: AccountRole,
  now: Date,
): Promise<void> {
  if (await store.readEmailMember(organizationId, email)) {
    throw new OrganizationError(OrganizationFailure.CONFLICT);
  }
  const account = await store.readVerifiedAccountByEmail(email);
  if (account) {
    const membership = await store.readMembership(organizationId, account.id);
    if (membership?.removedAt === null) {
      throw new OrganizationError(OrganizationFailure.CONFLICT);
    }
    if ((await store.countOrganizations(account.id)) >= OrganizationLimits.ORGANIZATIONS) {
      throw new OrganizationError(OrganizationFailure.CONFLICT);
    }
  }
  if (
    (await store.countMembers(organizationId)) + (await store.countEmailMembers(organizationId)) >=
    OrganizationLimits.MEMBERS
  ) {
    throw new OrganizationError(OrganizationFailure.CONFLICT);
  }
  if (account) {
    await store.saveMembership({
      organizationId,
      userId: account.id,
      role,
      joinedAt: now,
      removedAt: null,
    });
    await store.saveOrganizationChoice(account.id, true);
  } else {
    await store.saveEmailMember({ organizationId, email, role, addedAt: now });
  }
  await store.revokeInvitations(organizationId, email, now);
}

/** Matching requires an unambiguous verified email; no role or classroom enrollment is inferred. */
export async function applyEmailMemberships(
  store: OrganizationStore,
  account: OrganizationAccount,
  now: Date,
): Promise<void> {
  if (!account.emailVerified) {
    return;
  }
  const email = account.email.toLowerCase();
  const additions = await store.listEmailMemberships(email);
  if (
    additions.length === 0 ||
    (await store.readVerifiedAccountByEmail(email))?.id !== account.id
  ) {
    return;
  }
  for (const addition of additions) {
    const organization = await store.readOrganization(addition.organizationId);
    if (!organization || organization.isNameSet === false) {
      continue;
    }
    const membership = await store.readMembership(addition.organizationId, account.id);
    if (!membership || membership.removedAt !== null) {
      if (
        (await store.countMembers(addition.organizationId)) >= OrganizationLimits.MEMBERS ||
        (await store.countOrganizations(account.id)) >= OrganizationLimits.ORGANIZATIONS
      ) {
        continue;
      }
      await store.saveMembership({
        organizationId: addition.organizationId,
        userId: account.id,
        role: addition.role,
        joinedAt: addition.addedAt,
        removedAt: null,
      });
    }
    await store.removeEmailMember(addition.organizationId, email);
    await store.revokeInvitations(addition.organizationId, email, now);
    await store.saveOrganizationChoice(account.id, true);
  }
}
