import { z } from 'zod';
import { TeachingGoalEvidenceSchema } from '#contracts/TeachingStep.js';
export const TeachingDisposition = {
  AWAIT_ACTIVITY: 'await_activity',
  OBSERVE_AGAIN: 'observe_again',
  ASK: 'ask',
  COMPLETE: 'complete',
} as const;

/** Final output selects control flow; it cannot independently publish an instruction. */
export const TeachingReplySchema = z.strictObject({
  disposition: z.enum(TeachingDisposition),
  presentationId: z.uuid().nullable(),
  goalRevisionId: z.uuid().nullable(),
  captureId: z.string().min(1).max(256),
  observationSummary: z.string().trim().min(1).max(1200),
  message: z.string().trim().min(1).max(600).nullable(),
  reason: z.string().trim().min(1).max(600).nullable(),
  goalEvidence: TeachingGoalEvidenceSchema,
});

export type TeachingDecision = z.infer<typeof TeachingReplySchema>;
