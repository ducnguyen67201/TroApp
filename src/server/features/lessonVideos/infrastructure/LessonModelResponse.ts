import { z } from 'zod';
import { LessonModelUsageSchema, type LessonModelUsage } from '#contracts/LessonVisuals.js';

const responseSchema = z.object({
  id: z.string().max(200).optional(),
  status: z.string(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).optional(),
    })
    .nullish(),
});

/** Retain a safe usage receipt even when structured generation is incomplete or invalid. */
export function readLessonModelResponse(
  input: unknown,
): { status: string; text: string; usage: LessonModelUsage | null } | null {
  const result = responseSchema.safeParse(input);
  if (!result.success) {
    return null;
  }

  const response = result.data;
  const text = response.output
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('');
  const usage = response.usage
    ? LessonModelUsageSchema.parse({
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
        requestId: response.id ?? null,
      })
    : null;

  return { status: response.status, text, usage };
}

export function readLessonInputTokens(input: unknown): number {
  const result = z.object({ input_tokens: z.number().int().nonnegative() }).safeParse(input);
  if (!result.success) {
    throw new Error('Lesson model token count is invalid.');
  }
  return result.data.input_tokens;
}

export function parseLessonModelJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}
