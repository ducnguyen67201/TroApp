import { z } from 'zod';
import { CompletionMode, TaskOutcomeLimits } from '#contracts/TaskOutcome.js';

/** The actor references a worker-owned verdict instead of grading its own work. */
export const CompletionProposalSchema = z.strictObject({
  mode: z.enum(CompletionMode),
  answer: z.string().trim().min(1).max(TaskOutcomeLimits.MAX_ANSWER_CHARACTERS),
  verificationId: z.string().min(1).max(80).nullable(),
});

export type CompletionProposal = z.infer<typeof CompletionProposalSchema>;
