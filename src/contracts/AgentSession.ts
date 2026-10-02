import { z } from 'zod';
import { DesktopLocaleSchema } from './DesktopLocale.js';
import { AgentTaskMode, AgentTaskModeSchema, TeachingResultSchema } from './CursorCompanion.js';
import { DesktopDriverConnectionSchema } from './DesktopDriver.js';

export const AgentFailureCode = { DAILY_LIMIT: 'daily_limit' } as const;

/** Lifecycle and chat messages crossing renderer, main, and the local agent worker. */
export const AgentCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start') }),
  z.strictObject({ kind: z.literal('follow') }),
  z.strictObject({
    kind: z.literal('turn'),
    sessionId: z.uuid(),
    message: z.string().trim().min(1).max(8000),
    locale: DesktopLocaleSchema,
    mode: AgentTaskModeSchema.default(AgentTaskMode.EXECUTE),
  }),
  z.strictObject({ kind: z.literal('stop'), sessionId: z.uuid() }),
]);

export type AgentCommand = z.infer<typeof AgentCommandSchema>;

/** Main supplies a scoped model credential only over its private worker port. */
export const AgentWorkerCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('follow'),
    sessionId: z.uuid(),
    debugEnabled: z.boolean(),
    desktopDriver: DesktopDriverConnectionSchema,
    hudGroup: z.uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal('start'),
    sessionId: z.uuid(),
    gatewayToken: z.string().min(1),
    gatewayBaseUrl: z.url(),
    debugEnabled: z.boolean(),
    desktopDriver: DesktopDriverConnectionSchema,
    hudGroup: z.uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal('turn'),
    sessionId: z.uuid(),
    message: z.string().min(1),
    locale: DesktopLocaleSchema,
    mode: AgentTaskModeSchema.default(AgentTaskMode.EXECUTE),
  }),
  z.strictObject({ kind: z.literal('stop'), sessionId: z.uuid() }),
]);

export type AgentWorkerCommand = z.infer<typeof AgentWorkerCommandSchema>;

export const AgentResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), sessionId: z.uuid() }),
  z.strictObject({ kind: z.literal('completed'), answer: z.string() }),
  z.strictObject({ kind: z.literal('teaching'), result: TeachingResultSchema }),
  z.strictObject({ kind: z.literal('stopped') }),
  z.strictObject({
    kind: z.literal('failed'),
    message: z.string(),
    code: z.enum(AgentFailureCode).optional(),
  }),
]);

export type AgentResult = z.infer<typeof AgentResultSchema>;

export const AgentWorkerRequestSchema = z.strictObject({
  requestId: z.uuid(),
  command: AgentWorkerCommandSchema,
});

export const AgentWorkerResponseSchema = z.strictObject({
  requestId: z.uuid(),
  result: AgentResultSchema,
});
