import { z } from 'zod';
import { TeachingObservationSchema } from '../../../src/contracts/TeachingObservation.js';
import { AgentProgressPhase } from '../../../src/contracts/CompanionHud.js';

export const AgentRequestOutputKind = {
  TEACHING: 'teaching',
  NATIVE_TOOL: 'native_tool',
  PROGRESS: 'progress',
  FINAL: 'final',
} as const;

export const NativeToolStage = {
  REQUEST: 'request',
  RESPONSE: 'response',
  FAILED: 'failed',
} as const;

/** Explicit public outputs and tool metadata; native arguments/results and SDK
 * histories never enter this recording boundary. Timings use the worker clock. */
export const AgentRequestOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(AgentRequestOutputKind.TEACHING),
    observation: TeachingObservationSchema,
  }),
  z.strictObject({
    kind: z.literal(AgentRequestOutputKind.NATIVE_TOOL),
    stage: z.enum(NativeToolStage),
    callId: z.string().max(256).nullable(),
    toolName: z.string().min(1).max(256),
    isMutation: z.boolean().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    isError: z.boolean().nullable(),
  }),
  z.strictObject({
    kind: z.literal(AgentRequestOutputKind.PROGRESS),
    phase: z.enum(AgentProgressPhase),
  }),
  z.strictObject({
    kind: z.literal(AgentRequestOutputKind.FINAL),
    resultKind: z.string().min(1).max(64).nullable(),
    answer: z.string().max(32_000).nullable(),
    answerTruncated: z.boolean(),
    failed: z.boolean(),
  }),
]);

export type AgentRequestOutput = z.infer<typeof AgentRequestOutputSchema>;

/** Defense in depth for explicit benchmark artifacts, never a general logger.
 * The exact scoped token is removed before outputs cross the worker boundary. */
export function redactEvaluationText(text: string, credential: string | null = null): string {
  const withoutCredential = credential ? text.replaceAll(credential, '[credential removed]') : text;
  return withoutCredential
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [credential removed]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[provider credential removed]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token removed]')
    .replace(/data:(?:image|audio|video)\/[^\s"<>]+/gi, '[media removed]');
}

export function redactAgentRequestOutput(
  output: AgentRequestOutput,
  credential: string,
): AgentRequestOutput {
  const raw: unknown = JSON.parse(
    JSON.stringify(output, (_key, value: unknown) =>
      typeof value === 'string' ? redactEvaluationText(value, credential) : value,
    ),
  );
  return AgentRequestOutputSchema.parse(raw);
}
