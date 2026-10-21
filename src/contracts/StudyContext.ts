import { z } from 'zod';
import { CheckpointUpdateSchema, SessionCheckpointSchema } from './StudyMemory.js';
export const ActivityContextMarker = '[tro-activity-context]';

export const ContextLimits = {
  SOURCE_CHARACTERS: 32_000,
  BATCH_EVENTS: 20,
  EVENT_BYTES: 256 * 1024,
  PAGE_SIZE: 20,
  PACKET_CHARACTERS: 12_000,
  RETENTION_MS: 24 * 60 * 60_000,
  SESSION_MS: 3 * 60 * 60_000,
  OUTBOX_BYTES: 50 * 1024 * 1024,
} as const;

export const ContextEventKind = {
  RESOURCE: 'resource',
  OBSERVATION: 'observation',
  INPUT: 'input',
  ATTEMPT: 'attempt',
  RESULT: 'result',
  USER_MESSAGE: 'user_message',
} as const;

export const ContextFailure = {
  UNAUTHORIZED: 'unauthorized',
  DISABLED: 'disabled',
  STALE: 'stale',
  REVISION_CONFLICT: 'revision_conflict',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  FULL: 'full',
  MISSING: 'missing',
} as const;

export const ContextPreferenceSchema = z.strictObject({
  enabled: z.boolean(),
  available: z.boolean(),
  generation: z.number().int().nonnegative(),
  sessionId: z.uuid(),
});

export const ContextEventSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(ContextEventKind),
  resource: z.string().trim().min(1).max(500),
  observedAt: z.iso.datetime(),
  text: z.string().max(ContextLimits.SOURCE_CHARACTERS),
  limitation: z.string().max(500),
});

export const ContextSourceSchema = z.strictObject({
  id: z.uuid(),
  resource: z.string().min(1).max(500),
  text: z.string().max(ContextLimits.SOURCE_CHARACTERS),
  digest: z.string().min(1).max(80),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const ContextPacketSchema = z.strictObject({
  generation: z.number().int().nonnegative(),
  sessionId: z.uuid(),
  eventRevision: z.number().int().nonnegative(),
  checkpoint: SessionCheckpointSchema.nullable(),
  sources: z.array(ContextSourceSchema).max(ContextLimits.PAGE_SIZE),
  activity: z
    .array(
      z.strictObject({
        id: z.uuid(),
        sourceId: z.uuid(),
        kind: z.enum(ContextEventKind),
        sequence: z.number().int().positive(),
        observedAt: z.iso.datetime(),
        limitation: z.string().max(500),
      }),
    )
    .max(20),
  gaps: z.array(z.string().max(500)).max(12),
  nextCursor: z.string().max(100).nullable(),
});

const ScopeSchema = z.strictObject({ generation: z.number().int().nonnegative() });
export const ContextCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preferences') }),
  z.strictObject({
    kind: z.literal('set-enabled'),
    enabled: z.boolean(),
    expectedGeneration: z.number().int().nonnegative().optional(),
  }),
  ScopeSchema.extend({
    kind: z.literal('events'),
    events: z.array(ContextEventSchema).min(1).max(ContextLimits.BATCH_EVENTS),
  }),
  ScopeSchema.extend({
    kind: z.literal('resolve'),
    query: z.string().max(8000),
    cursor: z.string().max(100).nullable().default(null),
  }),
  ScopeSchema.extend({
    kind: z.literal('search'),
    query: z.string().trim().min(1).max(2000),
    cursor: z.string().max(100).nullable().default(null),
    includeRetained: z.boolean().optional(),
  }),
  ScopeSchema.extend({
    kind: z.literal('read-source'),
    sourceId: z.uuid(),
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(4000),
  }),
  ScopeSchema.extend({
    kind: z.literal('checkpoint'),
    updateId: z.uuid(),
    update: CheckpointUpdateSchema,
  }),
  ScopeSchema.extend({ kind: z.literal('forget') }),
  ScopeSchema.extend({ kind: z.literal('inspect') }),
  ScopeSchema.extend({
    kind: z.literal('correct'),
    expectedRevision: z.number().int().nonnegative(),
    summary: z.string().trim().min(1).max(2400),
  }),
]);

export const ContextReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preferences'), preference: ContextPreferenceSchema }),
  z.strictObject({ kind: z.literal('packet'), packet: ContextPacketSchema }),
  z.strictObject({ kind: z.literal('accepted'), revision: z.number().int().nonnegative() }),
  z.strictObject({
    kind: z.literal('source'),
    sourceId: z.uuid(),
    text: z.string().max(4000),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({ kind: z.literal('failed'), code: z.enum(ContextFailure) }),
]);

export type ContextPreference = z.infer<typeof ContextPreferenceSchema>;

export type ContextEvent = z.infer<typeof ContextEventSchema>;

export type ContextSource = z.infer<typeof ContextSourceSchema>;

export type ContextPacket = z.infer<typeof ContextPacketSchema>;

export type ContextCommand = z.infer<typeof ContextCommandSchema>;

export type ContextReply = z.infer<typeof ContextReplySchema>;
