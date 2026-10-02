import { z } from 'zod';
import { CompanionHudSnapshotSchema } from './CompanionHud.js';

export const CompanionHudWorkerCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('connect'),
    group: z.uuid(),
    snapshot: CompanionHudSnapshotSchema,
  }),
  z.strictObject({ kind: z.literal('snapshot'), snapshot: CompanionHudSnapshotSchema }),
]);

export const CompanionHudWorkerReplySchema = z.strictObject({ ready: z.boolean() });
