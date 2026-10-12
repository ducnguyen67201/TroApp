import { z } from 'zod';
import type { MaterialGenerationPolicy } from '../features/materials/application/MaterialGeneration.js';

const MaterialConfigSchema = z.strictObject({
  generation: z.strictObject({
    calls: z.number().int().min(1).max(100),
    inputTokens: z.number().int().positive().max(1_000_000),
    outputTokens: z.number().int().positive().max(200_000),
    stageInputTokens: z.number().int().positive().max(100_000),
    stageOutputTokens: z.number().int().min(1000).max(8000),
    compositionOutputTokens: z.number().int().min(2000).max(100_000),
    compositionTimeoutMs: z.number().int().min(90_000).max(540_000),
    deadlineMs: z.number().int().positive().max(540_000),
  }),
});

/** Brief and composition allowances remain separate; moving configuration does not remove admission limits. */
export const MaterialConfig = {
  generation: {
    calls: 24,
    inputTokens: 150_000,
    outputTokens: 160_000,
    stageInputTokens: 100_000,
    stageOutputTokens: 2000,
    compositionOutputTokens: 60_000,
    compositionTimeoutMs: 240_000,
    deadlineMs: 540_000,
  } satisfies MaterialGenerationPolicy,
} as const satisfies z.input<typeof MaterialConfigSchema>;

export type MaterialSettings = z.output<typeof MaterialConfigSchema>;

export function readMaterialConfig(
  configuration: MaterialSettings = MaterialConfig,
): MaterialSettings {
  const parsed = MaterialConfigSchema.safeParse(configuration);
  if (!parsed.success) {
    throw new Error('Material configuration is invalid.');
  }
  return parsed.data;
}
