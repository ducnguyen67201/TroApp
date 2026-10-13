import { z } from 'zod';

const visualPolicy = {
  enabled: false,
  model: 'gpt-5.4-mini',
  maxScenes: 2,
  inputTokens: 6000,
  outputTokens: 3000,
  attempts: 2,
  timeoutMs: 120000,
  maxSourceCharacters: 16000,
  maxDiagnosticCharacters: 1200,
  minimumRemainingMs: 60000,
} as const;

const visualPolicySchema = z.strictObject({
  enabled: z.boolean(),
  model: z.literal('gpt-5.4-mini'),
  maxScenes: z.number().int().min(0).max(2),
  inputTokens: z.number().int().min(1000).max(6000),
  outputTokens: z.number().int().min(1000).max(3000),
  attempts: z.number().int().min(1).max(2),
  timeoutMs: z.number().int().positive().max(180000),
  maxSourceCharacters: z.number().int().positive().max(24000),
  maxDiagnosticCharacters: z.number().int().positive().max(1200),
  minimumRemainingMs: z.number().int().positive().max(180000),
});

export const LessonVideoConfigSchema = z
  .strictObject({
    content: z.strictObject({
      model: z.literal('gpt-5.4-mini'),
      inputTokens: z.number().int().min(1000).max(12000),
      outputTokens: z.number().int().min(1000).max(6000),
      attempts: z.number().int().min(1).max(3),
      timeoutMs: z.number().int().positive().max(180000),
    }),
    /* Missing visual policy identifies a saved baseline-only job. Never replenish its allowance. */
    visual: visualPolicySchema.default(visualPolicy),
    speech: z.strictObject({
      model: z.string().min(1),
      voice: z.string().min(1),
      characters: z.number().int().positive().max(3000),
      attempts: z.number().int().min(1).max(3),
      timeoutMs: z.number().int().positive().max(60000),
    }),
    budget: z.strictObject({
      rateVersion: z.string(),
      inputMicroUsdPerToken: z.number().nonnegative(),
      cachedMicroUsdPerToken: z.number().nonnegative(),
      outputMicroUsdPerToken: z.number().nonnegative(),
      revisionMicroUsd: z.number().int().positive(),
      teacherMicroUsd: z.number().int().positive(),
      globalMicroUsd: z.number().int().positive(),
      teacherCharacters: z.number().int().positive(),
      globalCharacters: z.number().int().positive(),
    }),
    jobs: z.strictObject({
      pollMs: z.number().int().min(100),
      leaseMs: z.number().int().min(10000),
      heartbeatMs: z.number().int().min(1000),
      deadlineMs: z.number().int().positive().max(600000),
    }),
    render: z.strictObject({
      attempts: z.number().int().min(1).max(3),
      recoveries: z.number().int().min(0).max(1).default(0),
      timeoutMs: z.number().int().positive().max(180000),
      maxStoredBytes: z.number().int().positive(),
      maxLessonsPerTeacher: z.number().int().positive().max(100),
    }),
    presentation: z.strictObject({
      charactersPerSecond: z.number().min(5).max(30),
      minimumSeconds: z.number().min(1).max(30),
    }),
  })
  .refine(
    (value) =>
      value.jobs.heartbeatMs * 2 < value.jobs.leaseMs &&
      (!value.visual.enabled || value.content.attempts <= 2) &&
      (!value.visual.enabled || value.render.attempts >= value.visual.attempts + 1) &&
      value.content.attempts *
        (value.content.inputTokens * value.budget.inputMicroUsdPerToken +
          value.content.outputTokens * value.budget.outputMicroUsdPerToken) +
        (value.visual.enabled
          ? value.visual.maxScenes *
            value.visual.attempts *
            (value.visual.inputTokens * value.budget.inputMicroUsdPerToken +
              value.visual.outputTokens * value.budget.outputMicroUsdPerToken)
          : 0) <=
        value.budget.revisionMicroUsd,
  );

/** Reviewed feature policy. Credentials and renderer addresses stay in Env.ts. */
export const LessonVideoConfig = {
  content: {
    model: 'gpt-5.4-mini',
    inputTokens: 12000,
    outputTokens: 6000,
    attempts: 2,
    timeoutMs: 180000,
  },
  /* Each job also requires a renderer advertising the isolated visual runtime. */
  visual: { ...visualPolicy, enabled: true },
  speech: {
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    characters: 3000,
    attempts: 3,
    timeoutMs: 60000,
  },
  budget: {
    rateVersion: '2026-10-12-standard',
    inputMicroUsdPerToken: 0.75,
    cachedMicroUsdPerToken: 0.075,
    outputMicroUsdPerToken: 4.5,
    revisionMicroUsd: 150000,
    teacherMicroUsd: 1000000,
    globalMicroUsd: 10000000,
    teacherCharacters: 30000,
    globalCharacters: 100000,
  },
  jobs: { pollMs: 2000, leaseMs: 30000, heartbeatMs: 5000, deadlineMs: 600000 },
  render: {
    attempts: 3,
    recoveries: 1,
    timeoutMs: 180000,
    maxStoredBytes: 512 * 1024 * 1024,
    maxLessonsPerTeacher: 30,
  },
  presentation: { charactersPerSecond: 12, minimumSeconds: 6 },
} as const satisfies z.input<typeof LessonVideoConfigSchema>;

export type LessonVideoSettings = z.infer<typeof LessonVideoConfigSchema>;

export function readLessonVideoConfig(
  input: z.input<typeof LessonVideoConfigSchema> = LessonVideoConfig,
): LessonVideoSettings {
  const result = LessonVideoConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error('Lesson video configuration is invalid.');
  }
  return result.data;
}
