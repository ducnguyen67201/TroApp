import { z } from 'zod';
import { ContextCommandSchema, ContextReplySchema } from './StudyContext.js';

export const DesktopContextChannel = 'tro:activity-context';

export const DesktopContextCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preferences') }),
  z.strictObject({ kind: z.literal('set-enabled'), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('forget') }),
  z.strictObject({ kind: z.literal('inspect') }),
  z.strictObject({
    kind: z.literal('correct'),
    expectedRevision: z.number().int().nonnegative(),
    summary: z.string().trim().min(1).max(2400),
  }),
]);

export const ContextWorkerRequestSchema = z.strictObject({
  kind: z.literal('context-request'),
  requestId: z.uuid(),
  taskRequestId: z.uuid(),
  command: ContextCommandSchema,
});

export const ContextWorkerResponseSchema = z.strictObject({
  kind: z.literal('context-response'),
  requestId: z.uuid(),
  reply: ContextReplySchema,
});

export type DesktopContextCommand = z.infer<typeof DesktopContextCommandSchema>;
