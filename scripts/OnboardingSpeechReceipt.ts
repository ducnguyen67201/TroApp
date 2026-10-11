import { z } from 'zod';

/** Authoring cache metadata contains no credentials or provider response bodies. */
export const OnboardingSpeechReceiptSchema = z.strictObject({
  inputHash: z.string(),
  audioHash: z.string(),
  durationSeconds: z.number().positive(),
  sourceDurationSeconds: z.number().positive(),
  tempoFactor: z.number().min(1).max(1.15),
  provider: z.literal('openai'),
  voice: z.literal('marin'),
});
