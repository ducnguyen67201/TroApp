import { z } from 'zod';

export const AccountRole = { STUDENT: 'student', TEACHER: 'teacher' } as const;

export const AccountRoleSchema = z.enum(AccountRole);

export type AccountRole = (typeof AccountRole)[keyof typeof AccountRole];
