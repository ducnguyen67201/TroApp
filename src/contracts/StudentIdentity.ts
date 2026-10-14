import { z } from 'zod';

export const StudentDeviceMode = { PERSONAL: 'personal', SHARED: 'shared' } as const;

export type StudentDeviceMode = (typeof StudentDeviceMode)[keyof typeof StudentDeviceMode];

export const StudentDeviceLimits = {
  SHARED_IDLE_MS: 15 * 60_000,
  CAMERA_MS: 60_000,
  SESSION_CHECK_MS: 15_000,
} as const;

/** A school ID is an unverified claim, never a private account recovery credential. */
export const StudentIdentitySchema = z.strictObject({
  schoolId: z.uuid(),
  schoolName: z.string().min(1).max(100),
  classId: z.uuid(),
  externalId: z.string().min(1).max(128),
  mode: z.enum(StudentDeviceMode),
  provisional: z.literal(true),
});
