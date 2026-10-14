import { expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationFailure,
  OrganizationLimits,
} from '#contracts/Organizations.js';
import { OrganizationError } from '../../../../src/server/features/organizations/domain/OrganizationError.js';
import { createOrganizationFixture } from './OrganizationFixtures.js';

it('adds verified users immediately without changing global roles or accepting a code', async () => {
  const { service, store, owner, member, organization } = await createOrganizationFixture();
  await service.execute(owner.id, {
    kind: OrganizationAction.ADD_MEMBER,
    organizationId: organization.id,
    email: member.email,
    role: AccountRole.STUDENT,
  });
  expect(await store.readMembership(organization.id, member.id)).toMatchObject({
    role: AccountRole.STUDENT,
    removedAt: null,
  });
  expect(store.accounts.get(member.id)?.role).toBe(AccountRole.TEACHER);
  expect(store.invitations.size).toBe(0);
  expect(await service.execute(member.id, { kind: OrganizationAction.HOME })).toMatchObject({
    organizations: [{ id: organization.id, role: AccountRole.STUDENT }],
    hasChosenOrganization: true,
  });
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.ADD_MEMBER,
      organizationId: organization.id,
      email: member.email,
      role: AccountRole.TEACHER,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
});

it('links new emails only after verified sign-in and applies the latest assigned permissions once', async () => {
  const { service, store, owner, stranger, organization } = await createOrganizationFixture();
  store.accounts.delete(stranger.id);
  await service.execute(owner.id, {
    kind: OrganizationAction.ADD_MEMBER,
    organizationId: organization.id,
    email: stranger.email,
    role: AccountRole.STUDENT,
  });
  expect(await store.listEmailMembers(organization.id)).toMatchObject([
    { email: stranger.email, role: AccountRole.STUDENT },
  ]);
  await service.execute(owner.id, {
    kind: OrganizationAction.CHANGE_EMAIL_ROLE,
    organizationId: organization.id,
    email: stranger.email,
    role: AccountRole.TEACHER,
  });
  store.accounts.set(stranger.id, { ...stranger, emailVerified: false });
  await service.execute(stranger.id, { kind: OrganizationAction.HOME });
  expect(await store.readMembership(organization.id, stranger.id)).toBeNull();
  store.accounts.set(stranger.id, stranger);
  await service.execute(stranger.id, { kind: OrganizationAction.HOME });
  expect(await store.readMembership(organization.id, stranger.id)).toMatchObject({
    role: AccountRole.TEACHER,
  });
  expect(await store.listEmailMembers(organization.id)).toEqual([]);
  await service.execute(owner.id, {
    kind: OrganizationAction.CHANGE_ROLE,
    organizationId: organization.id,
    userId: stranger.id,
    role: AccountRole.STUDENT,
  });
  await service.execute(stranger.id, { kind: OrganizationAction.HOME });
  expect(await store.readMembership(organization.id, stranger.id)).toMatchObject({
    role: AccountRole.STUDENT,
  });
});

it('allows only the current owner to add people and remove unclaimed emails', async () => {
  const { service, store, owner, member, admin, organization } = await createOrganizationFixture();
  const command = {
    kind: OrganizationAction.ADD_MEMBER,
    organizationId: organization.id,
    email: 'new@example.test',
    role: AccountRole.STUDENT,
  };
  for (const account of [member, admin]) {
    await expect(service.execute(account.id, command)).rejects.toEqual(
      new OrganizationError(OrganizationFailure.FORBIDDEN),
    );
  }
  await service.execute(owner.id, command);
  await service.execute(owner.id, {
    kind: OrganizationAction.REMOVE_EMAIL_MEMBER,
    organizationId: organization.id,
    email: command.email,
  });
  expect(await store.listEmailMembers(organization.id)).toEqual([]);
  const count = vi.spyOn(store, 'countEmailMembers').mockResolvedValue(OrganizationLimits.MEMBERS);
  await expect(service.execute(owner.id, command)).rejects.toEqual(
    new OrganizationError(OrganizationFailure.CONFLICT),
  );
  count.mockRestore();
});

it('refuses ambiguous verified identities and never rolls back an existing member role', async () => {
  const { service, store, member, organization, now } = await createOrganizationFixture();
  await store.saveEmailMember({
    organizationId: organization.id,
    email: member.email,
    role: AccountRole.TEACHER,
    addedAt: now,
  });
  store.accounts.set('duplicate', {
    ...member,
    id: 'duplicate',
    email: member.email.toUpperCase(),
  });
  await service.execute(member.id, { kind: OrganizationAction.HOME });
  expect(await store.readMembership(organization.id, member.id)).toBeNull();
  store.accounts.delete('duplicate');
  await store.saveMembership({
    organizationId: organization.id,
    userId: member.id,
    role: AccountRole.STUDENT,
    joinedAt: now,
    removedAt: null,
  });
  await service.execute(member.id, { kind: OrganizationAction.HOME });
  expect(await store.readMembership(organization.id, member.id)).toMatchObject({
    role: AccountRole.STUDENT,
  });
  expect(await store.listEmailMembers(organization.id)).toEqual([]);
});

it('keeps ownership approval separate from the optional personal-use decision', async () => {
  const { service, store, admin, stranger, member } = await createOrganizationFixture();
  await expect(
    service.execute(stranger.id, {
      kind: OrganizationAction.CREATE_OWN_ORGANIZATION,
      name: 'Unapproved',
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  await expect(
    service.execute(member.id, { kind: OrganizationAction.APPROVE_OWNER, email: stranger.email }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  await service.execute(admin.id, {
    kind: OrganizationAction.APPROVE_OWNER,
    email: stranger.email,
  });
  expect(await service.execute(stranger.id, { kind: OrganizationAction.HOME })).toMatchObject({
    organizations: [],
    canCreateOrganization: true,
    hasChosenOrganization: false,
  });
  await service.execute(stranger.id, { kind: OrganizationAction.CONTINUE_PERSONAL });
  expect(await service.execute(stranger.id, { kind: OrganizationAction.HOME })).toMatchObject({
    organizations: [],
    canCreateOrganization: true,
    hasChosenOrganization: true,
  });
  await service.execute(stranger.id, {
    kind: OrganizationAction.CREATE_OWN_ORGANIZATION,
    name: 'My school',
  });
  expect(await service.execute(stranger.id, { kind: OrganizationAction.HOME })).toMatchObject({
    organizations: [{ name: 'My school', isOwner: true, isNameSet: true }],
    canCreateOrganization: false,
    hasChosenOrganization: true,
  });
  expect(store.accounts.get(stranger.id)?.isAdmin).toBe(false);
  const count = store.organizations.size;
  await service.execute(stranger.id, {
    kind: OrganizationAction.CREATE_OWN_ORGANIZATION,
    name: 'My school',
  });
  expect(store.organizations.size).toBe(count);
  await expect(
    service.execute(stranger.id, {
      kind: OrganizationAction.CREATE_OWN_ORGANIZATION,
      name: 'Changed school',
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
});
