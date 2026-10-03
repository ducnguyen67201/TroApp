import { z } from 'zod';
import { TaskOutcomeLimits } from '#contracts/TaskOutcome.js';

export const CriterionState = {
  SATISFIED: 'satisfied',
  UNSATISFIED: 'unsatisfied',
  UNKNOWN: 'unknown',
} as const;

const CriterionInputSchema = z.strictObject({
  description: z.string().trim().min(1).max(500),
});

export const DefineTaskGoalSchema = z.strictObject({
  summary: z.string().trim().min(1).max(1000),
  criteria: z.array(CriterionInputSchema).min(1).max(TaskOutcomeLimits.MAX_REQUIRED_CRITERIA),
});

export type DefineTaskGoalInput = z.input<typeof DefineTaskGoalSchema>;

export const TaskGoalSchema = z.strictObject({
  summary: DefineTaskGoalSchema.shape.summary,
  criteria: z
    .array(CriterionInputSchema.extend({ id: z.string().min(1) }))
    .min(1)
    .max(TaskOutcomeLimits.MAX_REQUIRED_CRITERIA),
});

export interface TaskGoal {
  readonly summary: string;
  readonly criteria: readonly Readonly<z.infer<typeof TaskGoalSchema>['criteria'][number]>[];
}

/** Criteria are fixed before desktop writes; only the worker assigns IDs. */
export function defineTaskGoal(input: DefineTaskGoalInput): TaskGoal {
  const parsed = DefineTaskGoalSchema.parse(input);
  return Object.freeze({
    ...parsed,
    criteria: Object.freeze(
      parsed.criteria.map((criterion, index) =>
        Object.freeze({ ...criterion, id: `criterion-${String(index + 1)}` }),
      ),
    ),
  });
}
