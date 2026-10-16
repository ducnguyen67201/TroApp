import { z } from 'zod';
import { ModelGatewayConfig } from './ModelGatewayConfig.js';

/** Validate Tro-owned fields; OpenAI validates the provider-specific request payload. */
export const ModelRequestSchema = z.looseObject({
  model: z.literal([ModelGatewayConfig.model, ModelGatewayConfig.legacyModel]),
  input: z.unknown(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

export type ModelRequest = z.infer<typeof ModelRequestSchema>;

const LegacyReasoningSchema = z.looseObject({ effort: z.literal('none') });

/** Rewrite the v1 compatibility alias and cap output, preserving input, tools and response format. */
export function prepareProviderModelRequest(request: ModelRequest): ModelRequest {
  const legacyReasoning =
    request.model === ModelGatewayConfig.legacyModel
      ? LegacyReasoningSchema.safeParse(request['reasoning'])
      : null;
  return {
    ...request,
    model: ModelGatewayConfig.model,
    /* Previous desktop SDKs defaulted to none, which the current model does not support. */
    ...(legacyReasoning?.success ? { reasoning: { ...legacyReasoning.data, effort: 'low' } } : {}),
    max_output_tokens: Math.min(
      request.max_output_tokens ?? ModelGatewayConfig.maximumOutputTokens,
      ModelGatewayConfig.maximumOutputTokens,
    ),
  };
}
