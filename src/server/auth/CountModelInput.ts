import { z } from 'zod';

export type CountModelInput = (
  request: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<number>;
const CountResponseSchema = z.object({ input_tokens: z.number().int().nonnegative() });

/** Count text, images, tool schemas and history using the provider's exact request format. */
export function createModelInputCounter(apiKey: string): CountModelInput {
  return async (request, signal) => {
    const fields = [
      'model',
      'input',
      'instructions',
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'text',
      'reasoning',
      'conversation',
      'previous_response_id',
      'personality',
    ];
    const body = Object.fromEntries(
      fields
        .filter((field) => request[field] !== undefined)
        .map((field) => [field, request[field]]),
    );
    const response = await fetch('https://api.openai.com/v1/responses/input_tokens', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error('Model input count unavailable.');
    }
    const value: unknown = await response.json();
    return CountResponseSchema.parse(value).input_tokens;
  };
}
