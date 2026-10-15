import { z } from 'zod';
import { AuthUserSchema } from './AuthSession.js';
import { StudentDeviceMode, StudentQrTextSchema } from './StudentIdentity.js';

export const StudentAccessPath = '/api/v1/student-access';

export const StudentSessionCookie = 'tro_student';

export const StudentAccessCapability = { HEADER: 'x-tro-student-access', VERSION: '1' } as const;

export const CompanyComputerCapability = {
  HEADER: 'x-tro-company-computers',
  VERSION: '1',
} as const;

export const StudentAccessKind = {
  STATUS: 'status',
  ACTIVATE: 'activate',
  ENROLL: 'enroll',
  CAMERA_START: 'camera-start',
  CAMERA_STOP: 'camera-stop',
  CREATE_COMPUTER_CODE: 'create-computer-code',
  ORGANIZATION_ACCESS: 'organization-access',
  REVOKE_COMPUTER_CODE: 'revoke-computer-code',
  REVOKE_COMPUTER: 'revoke-computer',
  DEACTIVATE: 'deactivate',
} as const;

export const OrganizationComputerLimits = { COMPUTERS: 100, ACTIVE_CODES: 100 } as const;

/** Existing field name is retained; the value can be any supported decoded QR text. */
export const StudentExternalIdSchema = StudentQrTextSchema;

/** Only organization-issued computer codes can authorize a new installation. */
export const StudentActivationCodeSchema = z.string().regex(/^TRO-[A-Z2-7]{16}$/);

export const StudentEnrollSchema = z.strictObject({
  kind: z.literal(StudentAccessKind.ENROLL),
  requestId: z.uuid(),
  externalId: StudentExternalIdSchema,
  // Returning QR logins keep the stored name; first sign-in requires it in persistence.
  name: z.string().trim().max(80).default(''),
});

export const StudentAccessCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(StudentAccessKind.STATUS) }),
  z.strictObject({
    kind: z.literal(StudentAccessKind.ACTIVATE),
    code: StudentActivationCodeSchema,
    requestId: z.uuid(),
    mode: z.enum(StudentDeviceMode).optional(),
  }),
  StudentEnrollSchema,
  z.strictObject({
    kind: z.literal(StudentAccessKind.CREATE_COMPUTER_CODE),
    organizationId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal(StudentAccessKind.ORGANIZATION_ACCESS),
    organizationId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal(StudentAccessKind.REVOKE_COMPUTER),
    organizationId: z.uuid(),
    deviceId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal(StudentAccessKind.REVOKE_COMPUTER_CODE),
    organizationId: z.uuid(),
    admissionId: z.uuid(),
  }),
  z.strictObject({ kind: z.literal(StudentAccessKind.DEACTIVATE) }),
  z.strictObject({ kind: z.literal(StudentAccessKind.CAMERA_START) }),
  z.strictObject({ kind: z.literal(StudentAccessKind.CAMERA_STOP) }),
]);

export type StudentAccessCommand = z.infer<typeof StudentAccessCommandSchema>;

export const StudentStaffAccessKinds: readonly StudentAccessCommand['kind'][] = [
  StudentAccessKind.CREATE_COMPUTER_CODE,
  StudentAccessKind.ORGANIZATION_ACCESS,
  StudentAccessKind.REVOKE_COMPUTER,
  StudentAccessKind.REVOKE_COMPUTER_CODE,
];

export type StudentEnrollment = z.infer<typeof StudentEnrollSchema>;

const StudentDeviceContextFields = z.strictObject({
  schoolId: z.uuid(),
  schoolName: z.string().min(1).max(120),
  classId: z.uuid().nullable(),
  className: z.string().min(1).max(200).nullable(),
  organizationId: z.uuid().optional(),
  mode: z.enum(StudentDeviceMode),
  expiresAt: z.iso.datetime(),
});

function hasConsistentComputerScope(device: z.infer<typeof StudentDeviceContextFields>): boolean {
  if (device.organizationId !== undefined) {
    return (
      device.classId === null &&
      device.className === null &&
      device.schoolId === device.organizationId
    );
  }
  return device.classId !== null && device.className !== null;
}

export const StudentDeviceContextSchema = StudentDeviceContextFields.superRefine(
  (device, context) => {
    if (!hasConsistentComputerScope(device)) {
      context.addIssue({ code: 'custom', message: 'Invalid computer authorization scope.' });
    }
  },
);

export const StudentAccessReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unconfigured') }),
  z.strictObject({ kind: z.literal('ready'), context: StudentDeviceContextSchema }),
  z.strictObject({ kind: z.literal('signed-in'), user: AuthUserSchema }),
  z.strictObject({
    kind: z.literal('admission'),
    code: StudentActivationCodeSchema,
    expiresAt: z.iso.datetime(),
    mode: z.enum(StudentDeviceMode),
  }),
  z.strictObject({
    kind: z.literal(StudentAccessKind.ORGANIZATION_ACCESS),
    organizationId: z.uuid(),
    day: z.iso.date(),
    authorizedComputers: z.number().int().nonnegative(),
    registeredStudents: z.number().int().nonnegative(),
    studentsToday: z.number().int().nonnegative(),
    signInsToday: z.number().int().nonnegative(),
    totalSignIns: z.number().int().nonnegative(),
    computers: z
      .array(
        z.strictObject({
          id: z.uuid(),
          name: z.string().max(100),
          createdAt: z.iso.datetime(),
          lastSignInAt: z.iso.datetime().nullable(),
          expiresAt: z.iso.datetime(),
          revoked: z.boolean(),
        }),
      )
      .max(OrganizationComputerLimits.COMPUTERS),
    activationCodes: z
      .array(
        z.strictObject({
          id: z.uuid(),
          activations: z.number().int().nonnegative(),
          expiresAt: z.iso.datetime(),
        }),
      )
      .max(OrganizationComputerLimits.ACTIVE_CODES),
  }),
  z.strictObject({ kind: z.literal('done') }),
  z.strictObject({ kind: z.literal('failed'), message: z.string().min(1).max(200) }),
]);

export type StudentAccessReply = z.infer<typeof StudentAccessReplySchema>;

export const StudentDeviceCredentialSchema = z.strictObject({
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  context: StudentDeviceContextSchema,
});

export const StudentSessionReplySchema = z.strictObject({
  user: AuthUserSchema,
  role: z.literal('student'),
  expiresAt: z.iso.datetime(),
});

export const StudentEnrollmentReplySchema = StudentSessionReplySchema.extend({
  credential: z.string().regex(/^[a-f0-9]{64}$/),
});
