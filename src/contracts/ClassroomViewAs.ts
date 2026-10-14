import { z } from 'zod';
import { AccountRoleSchema } from './AccountRole.js';

export const ClassroomViewAs = {
  HEADER: 'x-tro-classroom-view-as',
  PAGE_SIZE: 50,
} as const;

export const ClassroomPersonIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ClassroomPersonSchema = z.strictObject({
  id: ClassroomPersonIdSchema,
  name: z.string().min(1),
  email: z.email(),
  role: AccountRoleSchema,
});

export type ClassroomPerson = z.infer<typeof ClassroomPersonSchema>;

export const ClassroomPeoplePageSchema = z.strictObject({
  people: z.array(ClassroomPersonSchema).max(ClassroomViewAs.PAGE_SIZE),
  hasMore: z.boolean(),
});

export type ClassroomPeoplePage = z.infer<typeof ClassroomPeoplePageSchema>;
