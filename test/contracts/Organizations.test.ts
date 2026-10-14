import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  OrganizationAction,
  OrganizationCommandSchema,
  OrganizationReplySchema,
} from '#contracts/Organizations.js';

it('validates bounded organization commands without accepting ownership through member roles', () => {
  const organizationId = randomUUID();
  expect(
    OrganizationCommandSchema.parse({
      kind: OrganizationAction.CREATE_ORGANIZATION,
      name: '  Classroom studio  ',
      ownerEmail: 'OWNER@example.test',
    }),
  ).toEqual({
    kind: OrganizationAction.CREATE_ORGANIZATION,
    name: 'Classroom studio',
    ownerEmail: 'owner@example.test',
  });
  expect(
    OrganizationCommandSchema.safeParse({
      kind: OrganizationAction.CHANGE_ROLE,
      organizationId,
      userId: 'user',
      role: 'owner',
    }).success,
  ).toBe(false);
  expect(
    OrganizationCommandSchema.safeParse({
      kind: OrganizationAction.INVITE,
      organizationId,
      email: 'student@example.test',
      role: AccountRole.STUDENT,
      isOwner: true,
    }).success,
  ).toBe(false);
  expect(
    OrganizationCommandSchema.safeParse({
      kind: OrganizationAction.RENAME_ORGANIZATION,
      organizationId,
      name: ' ',
    }).success,
  ).toBe(false);
  expect(
    OrganizationCommandSchema.safeParse({
      kind: OrganizationAction.ACCEPT_INVITATION,
      code: 'short',
    }).success,
  ).toBe(false);
  expect(
    OrganizationReplySchema.safeParse({
      kind: 'home',
      organizations: [
        {
          id: organizationId,
          name: 'Studio',
          ownerUserId: 'owner',
          role: null,
          isOwner: false,
        },
      ],
      isAdmin: true,
    }).success,
  ).toBe(true);
});

it('accepts admin ownership provisioning without a name and validates the owner setup name', () => {
  expect(
    OrganizationCommandSchema.parse({
      kind: OrganizationAction.CREATE_ORGANIZATION,
      ownerEmail: 'owner@example.test',
    }),
  ).toEqual({ kind: OrganizationAction.CREATE_ORGANIZATION, ownerEmail: 'owner@example.test' });
  expect(
    OrganizationCommandSchema.parse({
      kind: OrganizationAction.SET_NAME,
      organizationId: randomUUID(),
      name: '  Our school  ',
    }),
  ).toMatchObject({ name: 'Our school' });
  for (const name of ['', '  ', 'x'.repeat(121)]) {
    expect(
      OrganizationCommandSchema.safeParse({
        kind: OrganizationAction.SET_NAME,
        organizationId: randomUUID(),
        name,
      }).success,
    ).toBe(false);
  }
});

it('accepts logo removal but rejects remote URLs, SVGs and oversized logo payloads', () => {
  const command = {
    kind: OrganizationAction.SET_LOGO,
    organizationId: randomUUID(),
    logoDataUrl: null,
  };
  expect(OrganizationCommandSchema.parse(command)).toEqual(command);
  for (const logoDataUrl of [
    'https://example.test/logo.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,' + 'a'.repeat(140_000),
  ]) {
    expect(OrganizationCommandSchema.safeParse({ ...command, logoDataUrl }).success).toBe(false);
  }
});

it('validates direct membership and optional first-login decisions without granting owner permissions', () => {
  expect(
    OrganizationCommandSchema.parse({
      kind: OrganizationAction.ADD_MEMBER,
      organizationId: randomUUID(),
      email: 'NEW@example.test',
      role: AccountRole.STUDENT,
    }),
  ).toMatchObject({ email: 'new@example.test' });
  expect(
    OrganizationCommandSchema.safeParse({
      kind: OrganizationAction.ADD_MEMBER,
      organizationId: randomUUID(),
      email: 'new@example.test',
      role: 'owner',
    }).success,
  ).toBe(false);
  expect(
    OrganizationCommandSchema.safeParse({
      kind: OrganizationAction.CREATE_OWN_ORGANIZATION,
      name: 'School',
      canCreateOrganization: true,
    }).success,
  ).toBe(false);
  expect(OrganizationCommandSchema.parse({ kind: OrganizationAction.CONTINUE_PERSONAL })).toEqual({
    kind: OrganizationAction.CONTINUE_PERSONAL,
  });
});

it('requires explicit class identity and previous assignment for owner class changes', () => {
  const command = {
    kind: OrganizationAction.ASSIGN_CLASS_TEACHER,
    organizationId: randomUUID(),
    classId: randomUUID(),
    teacherId: 'teacher',
    expectedTeacherId: 'previous',
  };
  expect(OrganizationCommandSchema.parse(command)).toEqual(command);
  expect(
    OrganizationCommandSchema.safeParse({ ...command, expectedTeacherId: undefined }).success,
  ).toBe(false);
  expect(OrganizationCommandSchema.safeParse({ ...command, isOwner: true }).success).toBe(false);
  expect(
    OrganizationCommandSchema.parse({
      kind: OrganizationAction.LINK_CLASS,
      organizationId: command.organizationId,
      classId: command.classId,
    }),
  ).toMatchObject({ kind: OrganizationAction.LINK_CLASS });
});

it('requires at least one distinct teacher and a distinct expected assignment set', () => {
  const command = {
    kind: OrganizationAction.SET_CLASS_TEACHERS,
    organizationId: randomUUID(),
    classId: randomUUID(),
    teacherIds: ['one', 'two'],
    expectedTeacherIds: ['one'],
  };
  expect(OrganizationCommandSchema.parse(command)).toEqual(command);
  for (const teacherIds of [[], ['one', 'one']]) {
    expect(OrganizationCommandSchema.safeParse({ ...command, teacherIds }).success).toBe(false);
  }
  expect(
    OrganizationCommandSchema.safeParse({ ...command, expectedTeacherIds: ['one', 'one'] }).success,
  ).toBe(false);
});
