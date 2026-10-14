import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationFailure,
  OrganizationLimits,
  OrganizationReplySchema,
} from '#contracts/Organizations.js';
import { OrganizationError } from '../../../../src/server/features/organizations/domain/OrganizationError.js';
import { createOrganizationFixture } from './OrganizationFixtures.js';

it('requires persisted admin authority to create organizations or appoint owners', async () => {
  const { service, store, admin, owner, member, organization } = await createOrganizationFixture();
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.CREATE_ORGANIZATION,
      name: 'Other',
      ownerEmail: member.email,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.GRANT_OWNER,
      organizationId: organization.id,
      email: member.email,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  store.accounts.set(member.id, { ...member, emailVerified: false });
  await expect(
    service.execute(admin.id, {
      kind: OrganizationAction.GRANT_OWNER,
      organizationId: organization.id,
      email: member.email,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.NOT_FOUND));
  store.accounts.set(member.id, member);
  expect(
    await service.execute(admin.id, {
      kind: OrganizationAction.CREATE_ORGANIZATION,
      name: 'Other',
      ownerEmail: member.email,
    }),
  ).toEqual({ kind: 'ok' });
  const created = [...store.organizations.values()].find((entry) => entry.name === 'Other');
  expect(created?.ownerUserId).toBe(member.id);
  expect(created && (await store.readMembership(created.id, member.id))).toMatchObject({
    role: AccountRole.STUDENT,
    removedAt: null,
  });
  store.accounts.set(admin.id, { ...admin, isAdmin: false });
  await expect(
    service.execute(admin.id, {
      kind: OrganizationAction.GRANT_OWNER,
      organizationId: organization.id,
      email: member.email,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
});

it('only exposes team profiles to the current owner while members see their own organization role', async () => {
  const { service, store, organization, owner, member, stranger, admin, now } =
    await createOrganizationFixture();
  await store.saveMembership({
    organizationId: organization.id,
    userId: member.id,
    role: AccountRole.STUDENT,
    joinedAt: now,
    removedAt: null,
  });
  expect(
    OrganizationReplySchema.parse(
      await service.execute(member.id, { kind: OrganizationAction.HOME }),
    ),
  ).toEqual({
    kind: 'home',
    organizations: [{ ...organization, role: AccountRole.STUDENT, isOwner: false }],
    isAdmin: false,
  });
  expect(await service.execute(stranger.id, { kind: OrganizationAction.HOME })).toEqual({
    kind: 'home',
    organizations: [],
    isAdmin: false,
  });
  expect(await service.execute(admin.id, { kind: OrganizationAction.HOME })).toEqual({
    kind: 'home',
    organizations: [{ ...organization, role: null, isOwner: false }],
    isAdmin: true,
  });
  for (const account of [member, stranger, admin]) {
    await expect(
      service.execute(account.id, {
        kind: OrganizationAction.TEAM,
        organizationId: organization.id,
      }),
    ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  }
  const team = await service.execute(owner.id, {
    kind: OrganizationAction.TEAM,
    organizationId: organization.id,
  });
  expect(team.kind).toBe('team');
  if (team.kind === 'team') {
    expect(team.members.map((entry) => entry.userId)).toEqual([owner.id, member.id]);
  }
});

it('binds invitation acceptance to a verified email, stores a digest and prevents replay', async () => {
  const { service, store, organization, owner, member, stranger } =
    await createOrganizationFixture();
  const reply = await service.execute(owner.id, {
    kind: OrganizationAction.INVITE,
    organizationId: organization.id,
    email: member.email,
    role: AccountRole.STUDENT,
  });
  if (reply.kind !== 'invitation') {
    throw new Error('Missing invitation fixture.');
  }
  expect(reply.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const invitation = [...store.invitations.values()][0];
  expect(invitation?.codeDigest).toBe(createHash('sha256').update(reply.code).digest('hex'));
  expect(JSON.stringify(invitation)).not.toContain(reply.code);
  await expect(
    service.execute(stranger.id, { kind: OrganizationAction.ACCEPT_INVITATION, code: reply.code }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  store.accounts.set(member.id, { ...member, emailVerified: false });
  await expect(
    service.execute(member.id, { kind: OrganizationAction.ACCEPT_INVITATION, code: reply.code }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  store.accounts.set(member.id, member);
  expect(
    await service.execute(member.id, {
      kind: OrganizationAction.ACCEPT_INVITATION,
      code: reply.code,
    }),
  ).toEqual({ kind: 'ok' });
  expect(await store.readMembership(organization.id, member.id)).toMatchObject({
    role: AccountRole.STUDENT,
  });
  expect(store.accounts.get(member.id)?.role).toBe(AccountRole.TEACHER);
  await expect(
    service.execute(member.id, { kind: OrganizationAction.ACCEPT_INVITATION, code: reply.code }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
});

it('replaces pending invitations and refuses expired, revoked and former-owner codes', async () => {
  const { service, store, organization, owner, member, admin, stranger, now } =
    await createOrganizationFixture();
  const command = {
    kind: OrganizationAction.INVITE,
    organizationId: organization.id,
    email: member.email,
    role: AccountRole.STUDENT,
  };
  const first = await service.execute(owner.id, command);
  const second = await service.execute(owner.id, { ...command, role: AccountRole.TEACHER });
  if (first.kind !== 'invitation' || second.kind !== 'invitation') {
    throw new Error('Missing invitation fixtures.');
  }
  await expect(
    service.execute(member.id, { kind: OrganizationAction.ACCEPT_INVITATION, code: first.code }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  const latest = [...store.invitations.values()].find(
    (invitation) => invitation.revokedAt === null,
  );
  if (!latest) {
    throw new Error('Missing active invitation fixture.');
  }
  store.invitations.set(latest.id, { ...latest, expiresAt: now });
  await expect(
    service.execute(member.id, { kind: OrganizationAction.ACCEPT_INVITATION, code: second.code }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  const third = await service.execute(owner.id, command);
  if (third.kind !== 'invitation') {
    throw new Error('Missing replacement invitation fixture.');
  }
  await service.execute(admin.id, {
    kind: OrganizationAction.GRANT_OWNER,
    organizationId: organization.id,
    email: stranger.email,
  });
  await expect(
    service.execute(member.id, { kind: OrganizationAction.ACCEPT_INVITATION, code: third.code }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  await expect(
    service.execute(owner.id, { kind: OrganizationAction.TEAM, organizationId: organization.id }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  expect(await store.readMembership(organization.id, owner.id)).toMatchObject({ removedAt: null });
  expect(await store.readMembership(organization.id, stranger.id)).toMatchObject({
    removedAt: null,
  });
});

it('changes roles within one organization and prevents owner removal or invitation role rollback', async () => {
  const { service, store, organization, owner, member, now } = await createOrganizationFixture();
  const secondId = randomUUID();
  await store.createOrganization({ id: secondId, name: 'Other', ownerUserId: owner.id });
  for (const organizationId of [organization.id, secondId]) {
    await store.saveMembership({
      organizationId,
      userId: member.id,
      role: AccountRole.STUDENT,
      joinedAt: now,
      removedAt: null,
    });
  }
  await service.execute(owner.id, {
    kind: OrganizationAction.CHANGE_ROLE,
    organizationId: organization.id,
    userId: member.id,
    role: AccountRole.TEACHER,
  });
  expect(await store.readMembership(organization.id, member.id)).toMatchObject({
    role: AccountRole.TEACHER,
  });
  expect(await store.readMembership(secondId, member.id)).toMatchObject({
    role: AccountRole.STUDENT,
  });
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.REMOVE_MEMBER,
      organizationId: organization.id,
      userId: owner.id,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.INVITE,
      organizationId: organization.id,
      email: member.email,
      role: AccountRole.STUDENT,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
  await service.execute(owner.id, {
    kind: OrganizationAction.REMOVE_MEMBER,
    organizationId: organization.id,
    userId: member.id,
  });
  expect(await store.readMembership(organization.id, member.id)).toMatchObject({ removedAt: now });
  expect(await store.readMembership(secondId, member.id)).toMatchObject({ removedAt: null });
  const invitation = await service.execute(owner.id, {
    kind: OrganizationAction.INVITE,
    organizationId: organization.id,
    email: member.email,
    role: AccountRole.STUDENT,
  });
  if (invitation.kind !== 'invitation') {
    throw new Error('Missing rejoin invitation.');
  }
  await service.execute(member.id, {
    kind: OrganizationAction.ACCEPT_INVITATION,
    code: invitation.code,
  });
  expect(await store.readMembership(organization.id, member.id)).toMatchObject({
    removedAt: null,
    role: AccountRole.STUDENT,
  });
});

it('refuses capacity overflow and cross-organization invitation revocation', async () => {
  const { service, store, organization, owner, member } = await createOrganizationFixture();
  const countMembers = vi
    .spyOn(store, 'countMembers')
    .mockResolvedValue(OrganizationLimits.MEMBERS);
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.INVITE,
      organizationId: organization.id,
      email: member.email,
      role: AccountRole.STUDENT,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
  countMembers.mockRestore();
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.REVOKE_INVITATION,
      organizationId: organization.id,
      invitationId: randomUUID(),
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.NOT_FOUND));
  await expect(service.execute('deleted-user', { kind: OrganizationAction.HOME })).rejects.toEqual(
    new OrganizationError(OrganizationFailure.UNAUTHORIZED),
  );
});

it('keeps the organization directory bounded and refuses ambiguous verified owner email matches', async () => {
  const { service, store, admin, member, organization } = await createOrganizationFixture();
  const countAllOrganizations = vi
    .spyOn(store, 'countAllOrganizations')
    .mockResolvedValue(OrganizationLimits.ORGANIZATIONS);
  await expect(
    service.execute(admin.id, {
      kind: OrganizationAction.CREATE_ORGANIZATION,
      name: 'Over capacity',
      ownerEmail: member.email,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
  countAllOrganizations.mockRestore();
  store.accounts.set('duplicate', {
    ...member,
    id: 'duplicate',
    email: member.email.toUpperCase(),
  });
  await expect(
    service.execute(admin.id, {
      kind: OrganizationAction.GRANT_OWNER,
      organizationId: organization.id,
      email: member.email,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.NOT_FOUND));
  expect(store.organizations.get(organization.id)?.ownerUserId).not.toBe(member.id);
});

it('lets only the appointed owner choose a pending organization name once', async () => {
  const { service, store, admin, owner, stranger } = await createOrganizationFixture();
  await service.execute(admin.id, {
    kind: OrganizationAction.CREATE_ORGANIZATION,
    ownerEmail: owner.email,
  });
  const pending = [...store.organizations.values()].find((entry) => entry.isNameSet === false);
  if (!pending) {
    throw new Error('Missing pending organization.');
  }
  const command = {
    kind: OrganizationAction.SET_NAME,
    organizationId: pending.id,
    name: 'Permanent school',
  };
  for (const account of [admin, stranger]) {
    await expect(service.execute(account.id, command)).rejects.toEqual(
      new OrganizationError(OrganizationFailure.FORBIDDEN),
    );
  }
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.INVITE,
      organizationId: pending.id,
      email: stranger.email,
      role: AccountRole.STUDENT,
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
  expect(await service.execute(owner.id, command)).toEqual({ kind: 'ok' });
  expect(await store.readOrganization(pending.id)).toMatchObject({
    name: 'Permanent school',
    isNameSet: true,
  });
  for (const kind of [OrganizationAction.SET_NAME, OrganizationAction.RENAME_ORGANIZATION]) {
    await expect(service.execute(owner.id, { ...command, kind, name: 'Changed' })).rejects.toEqual(
      new OrganizationError(OrganizationFailure.CONFLICT),
    );
  }
  await service.execute(admin.id, {
    kind: OrganizationAction.GRANT_OWNER,
    organizationId: pending.id,
    email: stranger.email,
  });
  await expect(
    service.execute(stranger.id, { ...command, name: 'Replacement owner school' }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
});

it('locks preexisting names and lets a replacement owner finish pending setup', async () => {
  const { service, store, owner, admin, stranger, organization } =
    await createOrganizationFixture();
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.RENAME_ORGANIZATION,
      organizationId: organization.id,
      name: 'Changed legacy name',
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.CONFLICT));
  store.organizations.set(organization.id, { ...organization, isNameSet: false });
  await service.execute(admin.id, {
    kind: OrganizationAction.GRANT_OWNER,
    organizationId: organization.id,
    email: stranger.email,
  });
  await expect(
    service.execute(owner.id, {
      kind: OrganizationAction.SET_NAME,
      organizationId: organization.id,
      name: 'Old owner',
    }),
  ).rejects.toEqual(new OrganizationError(OrganizationFailure.FORBIDDEN));
  await service.execute(stranger.id, {
    kind: OrganizationAction.SET_NAME,
    organizationId: organization.id,
    name: 'New owner school',
  });
  expect(await store.readOrganization(organization.id)).toMatchObject({
    name: 'New owner school',
    isNameSet: true,
  });
});
