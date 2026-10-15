import { z } from 'zod';

export const StudentDeviceMode = { PERSONAL: 'personal', SHARED: 'shared' } as const;

export type StudentDeviceMode = (typeof StudentDeviceMode)[keyof typeof StudentDeviceMode];

export const StudentDeviceLimits = {
  SHARED_IDLE_MS: 15 * 60_000,
  CAMERA_MS: 60_000,
  SESSION_CHECK_MS: 15_000,
} as const;

export const StudentQrLimits = { TEXT_CHARACTERS: 512 } as const;

/** QR text is an opaque account key: preserve URLs, whitespace, case and leading zeros. */
export const StudentQrTextSchema = z
  .string()
  .min(1)
  .max(StudentQrLimits.TEXT_CHARACTERS)
  .refine(
    (value) => value.trim().length > 0 && !value.includes('\0'),
    'The QR must contain non-empty text without null characters.',
  );

/** Organization QR login requires an authorized device; legacy grants retain class scope. */
const StudentIdentityFields = z.strictObject({
  schoolId: z.uuid(),
  schoolName: z.string().min(1).max(120),
  classId: z.uuid().nullable(),
  organizationId: z.uuid().optional(),
  externalId: StudentQrTextSchema,
  mode: z.enum(StudentDeviceMode),
  provisional: z.literal(true),
});

function hasConsistentStudentScope(identity: z.infer<typeof StudentIdentityFields>): boolean {
  if (identity.organizationId !== undefined) {
    return identity.classId === null && identity.schoolId === identity.organizationId;
  }
  return identity.classId !== null;
}

export const StudentIdentitySchema = StudentIdentityFields.superRefine((identity, context) => {
  if (!hasConsistentStudentScope(identity)) {
    context.addIssue({ code: 'custom', message: 'Invalid learner access scope.' });
  }
});
