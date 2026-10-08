import { z } from 'zod';
import { DesktopDriverConnectionSchema } from './DesktopDriver.js';
import { TeachingMessageSchema } from './TeachingStep.js';
import { CompanionHudSnapshotSchema, CompanionRenderTokenSchema } from './CompanionHud.js';

export const CompanionHudWorkerCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('connect'),
    group: z.uuid(),
    desktopDriver: DesktopDriverConnectionSchema,
    snapshot: CompanionHudSnapshotSchema,
  }),
  z.strictObject({ kind: z.literal('snapshot'), snapshot: CompanionHudSnapshotSchema }),
]);

export const CompanionHudWorkerReplySchema = z.union([
  z.strictObject({ ready: z.boolean() }),
  z.strictObject({ kind: z.literal('message'), message: TeachingMessageSchema.nullable() }),
]);

export const CompanionHudMessageSchema = z.strictObject({
  message: TeachingMessageSchema.nullable(),
  renderToken: CompanionRenderTokenSchema.optional(),
});

export type CompanionHudMessage = z.infer<typeof CompanionHudMessageSchema>;
