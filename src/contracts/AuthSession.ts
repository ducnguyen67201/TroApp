import { z } from 'zod';
import { StudentIdentitySchema } from './StudentIdentity.js';

export const AuthUserSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.email().nullable(),
    isAdmin: z.boolean().default(false),
    learner: StudentIdentitySchema.optional(),
  })
  .superRefine((user, context) => {
    if (
      (user.email === null && !user.learner) ||
      (user.learner && (user.isAdmin || user.email !== null))
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid account identity.' });
    }
  });

export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('signed-in'), user: AuthUserSchema }),
  z.strictObject({ kind: z.literal('signed-out') }),
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({
    kind: z.literal('failed'),
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
]);

export type AuthResult = z.infer<typeof AuthResultSchema>;

export const AuthCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status') }),
  z.strictObject({ kind: z.literal('sign-in-google') }),
  z.strictObject({ kind: z.literal('sign-out') }),
]);

export type AuthCommand = z.infer<typeof AuthCommandSchema>;

export const ModelCredentialSchema = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export type ModelCredential = z.infer<typeof ModelCredentialSchema>;
