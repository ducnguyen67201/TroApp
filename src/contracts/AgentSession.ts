import { z } from 'zod';

/** Lifecycle and chat messages crossing renderer, main, and the local agent worker. */
export const AgentCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start') }),
  z.strictObject({
    kind: z.literal('turn'),
    sessionId: z.uuid(),
    message: z.string().trim().min(1).max(8000),
  }),
  z.strictObject({ kind: z.literal('stop'), sessionId: z.uuid() }),
]);

export type AgentCommand = z.infer<typeof AgentCommandSchema>;

/** Main supplies a scoped model credential only over its private worker port. */
export const AgentWorkerCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('start'),
    sessionId: z.uuid(),
    gatewayToken: z.string().min(1),
    gatewayBaseUrl: z.url(),
    debugEnabled: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('turn'), sessionId: z.uuid(), message: z.string().min(1) }),
  z.strictObject({ kind: z.literal('stop'), sessionId: z.uuid() }),
]);

export type AgentWorkerCommand = z.infer<typeof AgentWorkerCommandSchema>;

export const AgentResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), sessionId: z.uuid() }),
  z.strictObject({ kind: z.literal('completed'), answer: z.string() }),
  z.strictObject({ kind: z.literal('stopped') }),
  z.strictObject({ kind: z.literal('failed'), message: z.string() }),
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
