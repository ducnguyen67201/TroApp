import { z } from 'zod';
import { ModelGatewayConfig } from './ModelGatewayConfig.js';

/** Validate Tro-owned fields; OpenAI validates the provider-specific request payload. */
export const ModelRequestSchema = z.looseObject({
  model: z.literal(ModelGatewayConfig.model),
  input: z.unknown(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

export type ModelRequest = z.infer<typeof ModelRequestSchema>;

/** Apply the backend output ceiling without altering input, tools or response format. */
export function limitModelOutputTokens(request: ModelRequest): ModelRequest {
  return {
    ...request,
    max_output_tokens: Math.min(
      request.max_output_tokens ?? ModelGatewayConfig.maximumOutputTokens,
      ModelGatewayConfig.maximumOutputTokens,
    ),
  };
}
