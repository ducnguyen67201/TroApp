import { z } from 'zod';

export const TaskOutcomeStatus = {
  SUCCEEDED: 'succeeded',
  PARTIAL: 'partial',
  BLOCKED: 'blocked',
  UNVERIFIED: 'unverified',
} as const;

export const CompletionMode = { RESPONSE: 'response', TASK: 'task' } as const;

export const TaskOutcomeLimits = {
  MAX_REQUIRED_CRITERIA: 5,
  MAX_ANSWER_CHARACTERS: 8000,
  MAX_LIMITATION_CHARACTERS: 2000,
} as const;

/** Public completion contains counts and a limitation, never desktop evidence. */
export const TaskOutcomeSchema = z
  .strictObject({
    status: z.enum(TaskOutcomeStatus),
    requiredCriteriaCount: z.number().int().min(1).max(TaskOutcomeLimits.MAX_REQUIRED_CRITERIA),
    supportedCriteriaCount: z.number().int().min(0).max(TaskOutcomeLimits.MAX_REQUIRED_CRITERIA),
    remainingCriteriaCount: z.number().int().min(0).max(TaskOutcomeLimits.MAX_REQUIRED_CRITERIA),
    limitation: z
      .string()
      .trim()
      .min(1)
      .max(TaskOutcomeLimits.MAX_LIMITATION_CHARACTERS)
      .nullable(),
  })
  .superRefine((value, context) => {
    const countsMatch =
      value.supportedCriteriaCount + value.remainingCriteriaCount === value.requiredCriteriaCount;
    const succeeded = value.status === TaskOutcomeStatus.SUCCEEDED;
    const partial = value.status === TaskOutcomeStatus.PARTIAL;
    if (
      !countsMatch ||
      (succeeded && value.remainingCriteriaCount !== 0) ||
      (partial && (value.supportedCriteriaCount === 0 || value.remainingCriteriaCount === 0)) ||
      (!succeeded && !partial && value.supportedCriteriaCount !== 0) ||
      (succeeded ? value.limitation !== null : value.limitation === null)
    ) {
      context.addIssue({ code: 'custom', message: 'Inconsistent task outcome.' });
    }
  });

export const AgentCompletionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(CompletionMode.RESPONSE) }),
  z.strictObject({ kind: z.literal(CompletionMode.TASK), outcome: TaskOutcomeSchema }),
]);

export type AgentCompletion = z.infer<typeof AgentCompletionSchema>;

export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;
