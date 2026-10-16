import { z } from 'zod';
import { ModelConfig } from '#contracts/config/ModelConfig.js';

const PracticeCheckConfigSchema = z.strictObject({
  model: z.string().min(1).max(100),
  policy: z.strictObject({
    dailyChecks: z.number().int().min(1).max(100),
    minuteChecks: z.number().int().min(1).max(10),
  }),
});

/** Shared text model with backend-owned practice limits; credentials remain in Env.ts. */
export const PracticeCheckConfig = {
  model: ModelConfig.textModel,
  policy: { dailyChecks: 30, minuteChecks: 5 },
} as const satisfies z.input<typeof PracticeCheckConfigSchema>;

export type PracticeCheckSettings = z.output<typeof PracticeCheckConfigSchema>;

export function readPracticeCheckConfig(
  configuration: PracticeCheckSettings = PracticeCheckConfig,
): PracticeCheckSettings {
  const parsed = PracticeCheckConfigSchema.safeParse(configuration);
  if (!parsed.success) {
    throw new Error('Practice check configuration is invalid.');
  }
  return parsed.data;
}
