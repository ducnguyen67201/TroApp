import { z } from 'zod';
import { AppUpdateVersionSchema } from './AppUpdate.js';

export const WhatsNewCommand = { READ: 'read', MARK_SEEN: 'mark-seen' } as const;

export const WhatsNewReplyKind = { OK: 'ok', FAILED: 'failed' } as const;

export const WhatsNewFailure = { UNAVAILABLE: 'unavailable' } as const;

export const WhatsNewCommandSchema = z.strictObject({ kind: z.enum(WhatsNewCommand) });

export const WhatsNewStatusSchema = z.strictObject({
  installedVersion: AppUpdateVersionSchema,
  releaseId: z.string().min(1).max(128).nullable(),
  hasUnseenRelease: z.boolean(),
  shouldAutoShow: z.boolean(),
});

export const WhatsNewReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(WhatsNewReplyKind.OK), status: WhatsNewStatusSchema }),
  z.strictObject({ kind: z.literal(WhatsNewReplyKind.FAILED), reason: z.enum(WhatsNewFailure) }),
]);

export type WhatsNewStatus = z.infer<typeof WhatsNewStatusSchema>;

export type WhatsNewReply = z.infer<typeof WhatsNewReplySchema>;
