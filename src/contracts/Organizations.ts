import { z } from 'zod';
import { OrganizationLogoDataUrlSchema } from './OrganizationLogo.js';
import { AccountRoleSchema } from './AccountRole.js';

export const OrganizationLimits = {
  NAME_LENGTH: 120,
  EMAIL_LENGTH: 254,
  ORGANIZATIONS: 100,
  MEMBERS: 500,
  CLASSES: 100,
  INVITATIONS: 100,
  INVITATION_LIFETIME_MS: 7 * 24 * 60 * 60 * 1000,
  INVITATION_CODE_LENGTH: 43,
} as const;

export const OrganizationAction = {
  HOME: 'home',
  TEAM: 'team',
  ASSIGN_CLASS_TEACHER: 'assign-class-teacher',
  SET_CLASS_TEACHERS: 'set-class-teachers',
  LINK_CLASS: 'link-class',
  CREATE_ORGANIZATION: 'create-organization',
  APPROVE_OWNER: 'approve-owner',
  CREATE_OWN_ORGANIZATION: 'create-own-organization',
  CONTINUE_PERSONAL: 'continue-personal',
  ADD_MEMBER: 'add-member',
  CHANGE_EMAIL_ROLE: 'change-email-role',
  REMOVE_EMAIL_MEMBER: 'remove-email-member',
  GRANT_OWNER: 'grant-owner',
  SET_NAME: 'set-name',
  SET_LOGO: 'set-logo',
  RENAME_ORGANIZATION: 'rename-organization',
  INVITE: 'invite',
  ACCEPT_INVITATION: 'accept-invitation',
  REVOKE_INVITATION: 'revoke-invitation',
  CHANGE_ROLE: 'change-role',
  REMOVE_MEMBER: 'remove-member',
} as const;

export const OrganizationFailure = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  INVALID: 'invalid',
  NOT_FOUND: 'not-found',
  CONFLICT: 'conflict',
  UNAVAILABLE: 'unavailable',
} as const;

export type OrganizationFailure = (typeof OrganizationFailure)[keyof typeof OrganizationFailure];

const OrganizationIdSchema = z.uuid();
const UserIdSchema = z.string().min(1).max(256);
const OrganizationNameSchema = z.string().trim().min(1).max(OrganizationLimits.NAME_LENGTH);
const OrganizationEmailSchema = z.email().max(OrganizationLimits.EMAIL_LENGTH).toLowerCase();
const InvitationCodeSchema = z
  .string()
  .length(OrganizationLimits.INVITATION_CODE_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

export const OrganizationSchema = z.strictObject({
  id: OrganizationIdSchema,
  name: OrganizationNameSchema,
  logoDataUrl: OrganizationLogoDataUrlSchema.nullable().optional(),
  /* Older replies represent already-named organizations. */
  isNameSet: z.boolean().optional(),
  ownerUserId: UserIdSchema,
});

export type Organization = z.infer<typeof OrganizationSchema>;

export const OrganizationSummarySchema = OrganizationSchema.extend({
  role: AccountRoleSchema.nullable(),
  isOwner: z.boolean(),
});

export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;

export const OrganizationMemberSchema = z.strictObject({
  userId: UserIdSchema,
  name: z.string().max(256),
  email: OrganizationEmailSchema,
  role: AccountRoleSchema,
  joinedAt: z.iso.datetime(),
});

export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;

export const OrganizationEmailMemberSchema = z.strictObject({
  email: OrganizationEmailSchema,
  role: AccountRoleSchema,
  addedAt: z.iso.datetime(),
});

export type OrganizationEmailMember = z.infer<typeof OrganizationEmailMemberSchema>;

export const OrganizationInvitationSchema = z.strictObject({
  id: z.uuid(),
  email: OrganizationEmailSchema,
  role: AccountRoleSchema,
  expiresAt: z.iso.datetime(),
});

export type OrganizationInvitation = z.infer<typeof OrganizationInvitationSchema>;

export const OrganizationClassSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  teacherId: UserIdSchema,
  teacherIds: z.array(UserIdSchema).min(1).max(OrganizationLimits.MEMBERS).optional(),
  hasLiveSession: z.boolean(),
});

export type OrganizationClass = z.infer<typeof OrganizationClassSchema>;

/** Organization membership grants no classroom assignment or enrollment. */
export const OrganizationCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(OrganizationAction.SET_CLASS_TEACHERS),
    organizationId: OrganizationIdSchema,
    classId: z.uuid(),
    teacherIds: z
      .array(UserIdSchema)
      .min(1)
      .max(OrganizationLimits.MEMBERS)
      .refine((ids) => new Set(ids).size === ids.length),
    expectedTeacherIds: z
      .array(UserIdSchema)
      .min(1)
      .max(OrganizationLimits.MEMBERS)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.ASSIGN_CLASS_TEACHER),
    organizationId: OrganizationIdSchema,
    classId: z.uuid(),
    teacherId: UserIdSchema,
    expectedTeacherId: UserIdSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.LINK_CLASS),
    organizationId: OrganizationIdSchema,
    classId: z.uuid(),
  }),
  z.strictObject({ kind: z.literal(OrganizationAction.HOME) }),
  z.strictObject({ kind: z.literal(OrganizationAction.CONTINUE_PERSONAL) }),
  z.strictObject({
    kind: z.literal(OrganizationAction.APPROVE_OWNER),
    email: OrganizationEmailSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.CREATE_OWN_ORGANIZATION),
    name: OrganizationNameSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.ADD_MEMBER),
    organizationId: OrganizationIdSchema,
    email: OrganizationEmailSchema,
    role: AccountRoleSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.CHANGE_EMAIL_ROLE),
    organizationId: OrganizationIdSchema,
    email: OrganizationEmailSchema,
    role: AccountRoleSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.REMOVE_EMAIL_MEMBER),
    organizationId: OrganizationIdSchema,
    email: OrganizationEmailSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.TEAM),
    organizationId: OrganizationIdSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.CREATE_ORGANIZATION),
    name: OrganizationNameSchema.optional(),
    ownerEmail: OrganizationEmailSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.GRANT_OWNER),
    organizationId: OrganizationIdSchema,
    email: OrganizationEmailSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.SET_NAME),
    organizationId: OrganizationIdSchema,
    name: OrganizationNameSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.RENAME_ORGANIZATION),
    organizationId: OrganizationIdSchema,
    name: OrganizationNameSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.SET_LOGO),
    organizationId: OrganizationIdSchema,
    logoDataUrl: OrganizationLogoDataUrlSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.INVITE),
    organizationId: OrganizationIdSchema,
    email: OrganizationEmailSchema,
    role: AccountRoleSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.ACCEPT_INVITATION),
    code: InvitationCodeSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.REVOKE_INVITATION),
    organizationId: OrganizationIdSchema,
    invitationId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.CHANGE_ROLE),
    organizationId: OrganizationIdSchema,
    userId: UserIdSchema,
    role: AccountRoleSchema,
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.REMOVE_MEMBER),
    organizationId: OrganizationIdSchema,
    userId: UserIdSchema,
  }),
]);

export type OrganizationCommand = z.infer<typeof OrganizationCommandSchema>;

export const OrganizationReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(OrganizationAction.HOME),
    organizations: z.array(OrganizationSummarySchema).max(OrganizationLimits.ORGANIZATIONS),
    isAdmin: z.boolean(),
    canCreateOrganization: z.boolean().optional(),
    hasChosenOrganization: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal(OrganizationAction.TEAM),
    organization: OrganizationSchema,
    members: z.array(OrganizationMemberSchema).max(OrganizationLimits.MEMBERS),
    invitations: z.array(OrganizationInvitationSchema).max(OrganizationLimits.INVITATIONS),
    emailMembers: z.array(OrganizationEmailMemberSchema).max(OrganizationLimits.MEMBERS).optional(),
    classes: z.array(OrganizationClassSchema).max(OrganizationLimits.CLASSES).optional(),
    personalClasses: z.array(OrganizationClassSchema).max(OrganizationLimits.CLASSES).optional(),
  }),
  z.strictObject({
    kind: z.literal('invitation'),
    code: InvitationCodeSchema,
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({ kind: z.literal('ok') }),
  z.strictObject({ kind: z.literal('failed'), code: z.enum(OrganizationFailure) }),
]);

export type OrganizationReply = z.infer<typeof OrganizationReplySchema>;
