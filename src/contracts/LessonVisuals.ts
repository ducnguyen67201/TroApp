import { z } from 'zod';

export const LessonVisualTreatment = {
  BASELINE: 'baseline',
  CUSTOM: 'custom',
} as const;

export const LessonVisualStatus = {
  PENDING: 'pending',
  SOURCE_SAVED: 'source_saved',
  READY: 'ready',
  DEGRADED: 'degraded',
} as const;

export const LessonVisualDegradation = {
  DISABLED: 'disabled',
  UNSUPPORTED: 'unsupported',
  BUDGET: 'budget',
  INPUT_LIMIT: 'input_limit',
  ATTEMPTS: 'attempts',
  INCOMPLETE: 'incomplete',
  INVALID_SOURCE: 'invalid_source',
  CODE_ERROR: 'code_error',
  DEADLINE: 'deadline',
  UNAVAILABLE: 'unavailable',
  EDITED: 'edited',
} as const;

export type LessonVisualTreatment =
  (typeof LessonVisualTreatment)[keyof typeof LessonVisualTreatment];

export type LessonVisualStatus = (typeof LessonVisualStatus)[keyof typeof LessonVisualStatus];

export type LessonVisualDegradation =
  (typeof LessonVisualDegradation)[keyof typeof LessonVisualDegradation];

/** Positions are writer proposals. The backend assigns and owns persistent screen IDs. */
export const LessonVisualBriefSchema = z.strictObject({
  position: z.number().int().min(0).max(5),
  objective: z.string().min(1).max(240),
  description: z.string().min(1).max(600),
  priority: z.number().int().min(1).max(6),
});

export type LessonVisualBrief = z.infer<typeof LessonVisualBriefSchema>;

/** Treatment is the effective output: a degraded custom selection renders the baseline. */
export const LessonVisualStateSchema = z.strictObject({
  treatment: z.enum(LessonVisualTreatment),
  status: z.enum(LessonVisualStatus),
  degradationReason: z.enum(LessonVisualDegradation).nullable(),
});

export type LessonVisualState = z.infer<typeof LessonVisualStateSchema>;

export const LessonModelRole = {
  CONTENT: 'content',
  VISUAL: 'visual',
} as const;

export const LessonModelAttemptState = {
  DISPATCHED: 'dispatched',
  COMPLETED: 'completed',
  INCOMPLETE: 'incomplete',
  UNAVAILABLE: 'unavailable',
} as const;

export const LessonModelUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  requestId: z.string().max(200).nullable(),
});

export type LessonModelUsage = z.infer<typeof LessonModelUsageSchema>;

/** Dispatch is saved before I/O. Unknown usage keeps the original reservation consumed. */
export const LessonModelAttemptSchema = z.strictObject({
  id: z.uuid(),
  role: z.enum(LessonModelRole),
  screenId: z.uuid().nullable(),
  ordinal: z.number().int().min(1).max(3),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputTokenLimit: z.number().int().positive(),
  outputTokenLimit: z.number().int().positive(),
  state: z.enum(LessonModelAttemptState),
  usage: LessonModelUsageSchema.nullable(),
  usageUncertain: z.boolean(),
});

export type LessonModelAttempt = z.infer<typeof LessonModelAttemptSchema>;

/** Backend-only checkpoint shape. Public LessonVideoSchema never includes this record. */
export const StoredLessonVisualSchema = z.strictObject({
  screenId: z.uuid(),
  brief: LessonVisualBriefSchema,
  sourceId: z.uuid().nullable(),
  sourceDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  inputDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sourceComplete: z.boolean(),
  diagnostic: z.string().max(1200).nullable(),
});

export type StoredLessonVisual = z.infer<typeof StoredLessonVisualSchema>;
