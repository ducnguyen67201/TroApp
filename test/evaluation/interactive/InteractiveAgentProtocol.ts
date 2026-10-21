import { z } from 'zod';
import { AgentResultSchema } from '../../../src/contracts/AgentSession.js';
import { ModelCredentialSchema } from '../../../src/contracts/AuthSession.js';
import { AgentTaskMode, AgentTaskModeSchema } from '../../../src/contracts/CursorCompanion.js';
import { DesktopDriverConnectionSchema } from '../../../src/contracts/DesktopDriver.js';
import { AgentRequestOutputSchema } from './AgentRequestOutput.js';
import { DesktopLocale, DesktopLocaleSchema } from '../../../src/contracts/DesktopLocale.js';

export const InteractiveAgentMessageKind = {
  RUN: 'run',
  CANCEL: 'cancel',
  SETTLED: 'settled',
  CUE_INSTALLED: 'cue-installed',
  OUTPUT: 'output',
} as const;

function isAllowedGatewayUrl(value: string): boolean {
  const url = new URL(value);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback))
  );
}

export const InteractiveGatewayUrlSchema = z.url().refine(isAllowedGatewayUrl);

export const InteractiveModelRequestSchema = z.strictObject({
  id: z.uuid(),
  status: z.number().int().min(100).max(599).nullable(),
  durationMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
});

/** Main alone supplies native transport metadata and a short-lived model credential.
 * Neither the credential nor this private protocol crosses the fixture renderer. */
export const InteractiveAgentRunSchema = z.strictObject({
  kind: z.literal(InteractiveAgentMessageKind.RUN),
  trialId: z.uuid(),
  desktopDriver: DesktopDriverConnectionSchema,
  credential: ModelCredentialSchema,
  gatewayBaseUrl: InteractiveGatewayUrlSchema,
  request: z.string().trim().min(1).max(8000),
  historyText: z.string().max(32_000),
  contextEnabled: z.boolean(),
  taskMode: AgentTaskModeSchema.default(AgentTaskMode.EXECUTE),
  locale: DesktopLocaleSchema.default(DesktopLocale.ENGLISH),
});

export const InteractiveAgentCancelSchema = z.strictObject({
  kind: z.literal(InteractiveAgentMessageKind.CANCEL),
  trialId: z.uuid(),
});

export const InteractiveAgentRequestSchema = z.discriminatedUnion('kind', [
  InteractiveAgentRunSchema,
  InteractiveAgentCancelSchema,
]);

export const InteractiveAgentSettledSchema = z.strictObject({
  kind: z.literal(InteractiveAgentMessageKind.SETTLED),
  trialId: z.uuid(),
  result: AgentResultSchema.nullable(),
  failed: z.boolean(),
  durationMs: z.number().nonnegative(),
  contextPreparationMs: z.number().nonnegative().nullable(),
  modelRequests: z.array(InteractiveModelRequestSchema).max(1000),
  toolCalls: z.number().int().nonnegative(),
  mutationCalls: z.number().int().nonnegative(),
  studentInputCalls: z.number().int().nonnegative().nullable().default(null),
  outputCount: z.number().int().nonnegative().default(0),
});

export const InteractiveAgentOutputSchema = z.strictObject({
  kind: z.literal(InteractiveAgentMessageKind.OUTPUT),
  trialId: z.uuid(),
  sequence: z.number().int().positive(),
  elapsedMs: z.number().nonnegative(),
  output: AgentRequestOutputSchema,
});

/** A host/compositor acknowledgment, not independent proof of visible pixels. */
export const InteractiveAgentCueSchema = z.strictObject({
  kind: z.literal(InteractiveAgentMessageKind.CUE_INSTALLED),
  trialId: z.uuid(),
  elapsedMs: z.number().nonnegative(),
});

export const InteractiveAgentResponseSchema = z.discriminatedUnion('kind', [
  InteractiveAgentSettledSchema,
  InteractiveAgentCueSchema,
  InteractiveAgentOutputSchema,
]);

export type InteractiveAgentRun = z.infer<typeof InteractiveAgentRunSchema>;

export type InteractiveAgentRequest = z.infer<typeof InteractiveAgentRequestSchema>;

export type InteractiveAgentSettled = z.infer<typeof InteractiveAgentSettledSchema>;

export type InteractiveAgentOutput = z.infer<typeof InteractiveAgentOutputSchema>;

export type InteractiveAgentResponse = z.infer<typeof InteractiveAgentResponseSchema>;

export type InteractiveModelRequest = z.infer<typeof InteractiveModelRequestSchema>;
