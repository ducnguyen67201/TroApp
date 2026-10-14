import { z } from 'zod';
import { AuthUserSchema } from './AuthSession.js';
import { StudentDeviceMode } from './StudentIdentity.js';

export const StudentAccessPath = '/api/v1/student-access';

export const StudentSessionCookie = 'tro_student';

export const StudentAccessCapability = { HEADER: 'x-tro-student-access', VERSION: '1' } as const;

export const StudentAccessKind = {
  STATUS: 'status',
  ACTIVATE: 'activate',
  ENROLL: 'enroll',
  CREATE_ADMISSION: 'create-admission',
  REVOKE_ADMISSION: 'revoke-admission',
  PREVIEW_ROSTER: 'preview-roster',
  APPLY_ROSTER: 'apply-roster',
  CAMERA_START: 'camera-start',
  CAMERA_STOP: 'camera-stop',
} as const;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

/** Raw card contents stay strings: never strip leading zeros or uppercase student IDs. */
export const StudentExternalIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value === value.trim() &&
      !hasControlCharacter(value) &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(value),
    'Enter the student ID printed on the card.',
  );
const admissionCode = z.string().regex(/^[A-Z2-7]{16}$/);
export const StudentEnrollSchema = z.strictObject({
  kind: z.literal(StudentAccessKind.ENROLL),
  requestId: z.uuid(),
  externalId: StudentExternalIdSchema,
  name: z.string().trim().min(1).max(80),
});

export const StudentRosterRowsSchema = z
  .array(
    z.strictObject({
      externalId: StudentExternalIdSchema,
      name: z.string().trim().min(1).max(80),
    }),
  )
  .min(1)
  .max(500);

export const StudentAccessCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(StudentAccessKind.STATUS) }),
  z.strictObject({
    kind: z.literal(StudentAccessKind.ACTIVATE),
    code: admissionCode,
    requestId: z.uuid(),
  }),
  StudentEnrollSchema,
  z.strictObject({
    kind: z.literal(StudentAccessKind.CREATE_ADMISSION),
    classId: z.uuid(),
    schoolName: z.string().trim().min(1).max(100),
    mode: z.enum(StudentDeviceMode),
  }),
  z.strictObject({ kind: z.literal(StudentAccessKind.REVOKE_ADMISSION), classId: z.uuid() }),
  z.strictObject({
    kind: z.literal(StudentAccessKind.PREVIEW_ROSTER),
    classId: z.uuid(),
    rows: StudentRosterRowsSchema,
  }),
  z.strictObject({
    kind: z.literal(StudentAccessKind.APPLY_ROSTER),
    classId: z.uuid(),
    rows: StudentRosterRowsSchema,
    revision: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal(StudentAccessKind.CAMERA_START) }),
  z.strictObject({ kind: z.literal(StudentAccessKind.CAMERA_STOP) }),
]);

export type StudentAccessCommand = z.infer<typeof StudentAccessCommandSchema>;

export const StudentStaffAccessKinds: readonly StudentAccessCommand['kind'][] = [
  StudentAccessKind.CREATE_ADMISSION,
  StudentAccessKind.REVOKE_ADMISSION,
  StudentAccessKind.PREVIEW_ROSTER,
  StudentAccessKind.APPLY_ROSTER,
];

export type StudentEnrollment = z.infer<typeof StudentEnrollSchema>;

export const StudentDeviceContextSchema = z.strictObject({
  schoolId: z.uuid(),
  schoolName: z.string().min(1).max(100),
  classId: z.uuid(),
  className: z.string().min(1).max(200),
  mode: z.enum(StudentDeviceMode),
  expiresAt: z.iso.datetime(),
});

export const StudentAccessReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unconfigured') }),
  z.strictObject({ kind: z.literal('ready'), context: StudentDeviceContextSchema }),
  z.strictObject({ kind: z.literal('signed-in'), user: AuthUserSchema }),
  z.strictObject({
    kind: z.literal('admission'),
    code: admissionCode,
    expiresAt: z.iso.datetime(),
    mode: z.enum(StudentDeviceMode),
  }),
  z.strictObject({
    kind: z.literal('roster-preview'),
    revision: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    conflicts: z.array(StudentExternalIdSchema).max(500),
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
