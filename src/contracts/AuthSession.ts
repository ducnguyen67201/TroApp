import { z } from 'zod';

export const AuthUserSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
});

export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('signed-in'), user: AuthUserSchema }),
  z.strictObject({ kind: z.literal('signed-out') }),
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('failed'), message: z.string() }),
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
