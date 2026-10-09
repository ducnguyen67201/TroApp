import { z } from 'zod';
import { ModelTransportSnapshotSchema } from './ModelTransportDiagnostics.js';

export const ModelRequestTraceHeader = 'x-tro-model-request-id';

export const ProviderClientRequestHeader = 'x-client-request-id';

export const ModelRequestTraceSchema = z.uuid();

export const ModelFailureStage = {
  UNOBSERVED: 'unobserved',
  CLIENT_DISCONNECTED: 'client_disconnected',
  DEADLINE: 'deadline',
  BEFORE_CONNECTION: 'before_connection',
  UPLOAD: 'upload',
  WAITING_FOR_HEADERS: 'waiting_for_headers',
  PROVIDER_RESPONSE: 'provider_response',
  RESPONSE_STREAM: 'response_stream',
} as const;

export const ModelConnectionUse = { UNKNOWN: 'unknown', NEW: 'new', REUSED: 'reused' } as const;

export const ModelAbortSource = { CLIENT: 'client', DEADLINE: 'deadline' } as const;

export const ModelFailureEvidenceSchema = z.strictObject({
  failureStage: z.enum(ModelFailureStage),
  connectionUse: z.enum(ModelConnectionUse),
});

export type ModelFailureEvidence = z.infer<typeof ModelFailureEvidenceSchema>;

/** Allowlisted diagnostics only. Raw provider messages, bodies and credentials never cross here. */
export const ProviderErrorCodeSchema = z.enum([
  'invalid_api_key',
  'insufficient_quota',
  'rate_limit_exceeded',
  'context_length_exceeded',
  'invalid_value',
  'invalid_image',
  'invalid_image_format',
  'invalid_image_url',
  'invalid_base64',
  'unknown_parameter',
  'missing_required_parameter',
  'invalid_request',
  'invalid_request_error',
  'server_error',
  'model_not_found',
  'content_policy_violation',
  'unsupported_value',
  'invalid_json',
]);

export const ProviderErrorTypeSchema = z.enum([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'rate_limit_error',
  'server_error',
  'api_error',
  'insufficient_quota',
]);

export const NetworkErrorCodeSchema = z.enum([
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export const ModelGatewayDiagnosticsSchema = z.object({
  gatewayRequestId: z.string().regex(/^req[-_][A-Za-z0-9_-]{1,128}$/),
  modelRequestId: ModelRequestTraceSchema.optional(),
  providerClientRequestId: ModelRequestTraceSchema.optional(),
  failureStage: z.enum(ModelFailureStage).optional(),
  connectionUse: z.enum(ModelConnectionUse).optional(),
  abortSource: z.enum(ModelAbortSource).nullable().optional(),
  reason: z.enum([
    'provider_network_failed',
    'provider_rejected',
    'provider_body_missing',
    'client_disconnected',
  ]),
  attemptNumber: z.number().int().min(0).max(2),
  durationMs: z.number().nonnegative(),
  timedOut: z.boolean().optional(),
  transport: ModelTransportSnapshotSchema.optional(),
  errorType: z
    .enum(['AbortError', 'TimeoutError', 'TypeError', 'AggregateError', 'unknown'])
    .optional(),
  networkCode: NetworkErrorCodeSchema.nullable().optional(),
  networkSyscall: z.enum(['write', 'read', 'connect', 'getaddrinfo']).nullable().optional(),
  networkErrno: z.number().int().min(-65535).max(65535).nullable().optional(),
  causeDepth: z.number().int().min(0).max(5).nullable().optional(),
  providerStatus: z.number().int().min(100).max(599).optional(),
  providerRequestId: z
    .string()
    .regex(/^req_[A-Za-z0-9_-]{1,128}$/)
    .nullable()
    .optional(),
  providerErrorCode: ProviderErrorCodeSchema.nullable().optional(),
  providerErrorType: ProviderErrorTypeSchema.nullable().optional(),
  providerParameter: z
    .string()
    .max(160)
    .regex(
      /^(?:model|input|tools|instructions|stream|max_output_tokens|previous_response_id|text|reasoning|temperature|top_p|parallel_tool_calls)(?:\[\d{1,5}\]|\.(?:content|type|text|image_url|image|detail|name|parameters|properties|required|additionalProperties|strict|format|schema|effort|arguments|output|call_id))*$/,
    )
    .nullable()
    .optional(),
  providerDiagnosticsAvailable: z.boolean().optional(),
});

export type ModelGatewayDiagnostics = z.infer<typeof ModelGatewayDiagnosticsSchema>;

/** Accept both the HTTP envelope and the OpenAI SDK's extracted error object. */
export function readModelGatewayDiagnostics(value: unknown): ModelGatewayDiagnostics | null {
  const envelope = z
    .object({ diagnostics: z.unknown().optional(), error: z.unknown().optional() })
    .safeParse(value);
  if (!envelope.success) {
    return null;
  }
  const nested = z.object({ diagnostics: z.unknown().optional() }).safeParse(envelope.data.error);
  const parsed = ModelGatewayDiagnosticsSchema.safeParse(
    envelope.data.diagnostics ?? (nested.success ? nested.data.diagnostics : undefined),
  );
  return parsed.success ? parsed.data : null;
}
