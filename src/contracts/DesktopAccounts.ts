import { z } from 'zod';
import { AuthResultSchema, AuthUserSchema } from './AuthSession.js';
import { AccountRoleSchema } from './AccountRole.js';

export const DesktopAccountLimits = { MAX_ACCOUNTS: 10, SIGN_IN_TIMEOUT_MS: 120_000 } as const;

/** Device-local account metadata only. Session cookies never cross preload. */
export const SavedAccountSchema = z.strictObject({
  id: z.uuid(),
  user: AuthUserSchema,
  role: AccountRoleSchema.nullable(),
  requiresSignIn: z.boolean(),
});

export type SavedAccount = z.infer<typeof SavedAccountSchema>;

export const SavedAccountsSchema = z.strictObject({
  kind: z.literal('accounts'),
  accounts: z.array(SavedAccountSchema).max(DesktopAccountLimits.MAX_ACCOUNTS),
  activeAccountId: z.uuid().nullable(),
});

export type SavedAccounts = z.infer<typeof SavedAccountsSchema>;

export const AccountCommandKind = {
  LIST: 'list',
  ADD_GOOGLE: 'add-google',
  SWITCH: 'switch',
  CANCEL_ADD: 'cancel-add',
} as const;

export const AccountCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(AccountCommandKind.LIST) }),
  z.strictObject({ kind: z.literal(AccountCommandKind.ADD_GOOGLE) }),
  z.strictObject({ kind: z.literal(AccountCommandKind.SWITCH), accountId: z.uuid() }),
  z.strictObject({ kind: z.literal(AccountCommandKind.CANCEL_ADD) }),
]);

export type AccountCommand = z.infer<typeof AccountCommandSchema>;

export const AccountReplySchema = z.union([SavedAccountsSchema, AuthResultSchema]);

export type AccountReply = z.infer<typeof AccountReplySchema>;
