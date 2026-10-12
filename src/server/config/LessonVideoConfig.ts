import { z } from 'zod';

export const LessonVideoConfigSchema = z
  .strictObject({
    content: z.strictObject({
      model: z.literal('gpt-5.4-mini'),
      inputTokens: z.number().int().min(1000).max(12000),
      outputTokens: z.number().int().min(1000).max(6000),
      attempts: z.number().int().min(1).max(3),
      timeoutMs: z.number().int().positive().max(180000),
    }),
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
      value.content.attempts *
        (value.content.inputTokens * value.budget.inputMicroUsdPerToken +
          value.content.outputTokens * value.budget.outputMicroUsdPerToken) <=
        value.budget.revisionMicroUsd,
  );

/** Reviewed feature policy. Credentials and renderer addresses stay in Env.ts. */
export const LessonVideoConfig = {
  content: {
    model: 'gpt-5.4-mini',
    inputTokens: 12000,
    outputTokens: 6000,
    attempts: 3,
    timeoutMs: 180000,
  },
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
    timeoutMs: 180000,
    maxStoredBytes: 512 * 1024 * 1024,
    maxLessonsPerTeacher: 30,
  },
  presentation: { charactersPerSecond: 12, minimumSeconds: 6 },
} as const satisfies z.input<typeof LessonVideoConfigSchema>;

export type LessonVideoSettings = z.infer<typeof LessonVideoConfigSchema>;

export function readLessonVideoConfig(
  input: LessonVideoSettings = LessonVideoConfig,
): LessonVideoSettings {
  const result = LessonVideoConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error('Lesson video configuration is invalid.');
  }
  return result.data;
}
