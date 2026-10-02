import { z } from 'zod';

export const ModelGatewayFailure = {
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  CREDENTIAL_REQUIRED: 'credential_required',
  CREDENTIAL_INVALID: 'credential_invalid',
  REQUEST_INVALID: 'request_invalid',
  NETWORK_FAILED: 'provider_network_failed',
  PROVIDER_REJECTED: 'provider_rejected',
  BODY_MISSING: 'provider_body_missing',
  STREAM_FAILED: 'provider_stream_failed',
  CLIENT_DISCONNECTED: 'client_disconnected',
} as const;

export const ModelGatewayEvent = {
  REQUEST: 'model.gateway.request',
  REJECTED: 'model.gateway.rejected',
  DISPATCH: 'model.gateway.dispatch',
  RETRY: 'model.gateway.retry',
  RESPONSE: 'model.gateway.response',
  FAILED: 'model.gateway.failed',
  COMPLETED: 'model.gateway.completed',
} as const;

/* Provider-owned vocabulary: unknown codes/messages must never become log content. */
const ProviderErrorCodes = new Set([
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

const ProviderErrorTypes = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'rate_limit_error',
  'server_error',
  'api_error',
  'insufficient_quota',
]);

const NetworkErrorCodes = new Set([
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

const ProviderErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.unknown().optional(),
    type: z.unknown().optional(),
    param: z.unknown().optional(),
  }),
});

const NetworkErrorSchema = z.looseObject({ code: z.unknown().optional() });

/** Accept only schema field paths; arbitrary provider params can contain user content. */
function readProviderParameter(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160) {
    return null;
  }
  return /^(?:model|input|tools|instructions|stream|max_output_tokens|previous_response_id|text|reasoning|temperature|top_p|parallel_tool_calls)(?:\[\d{1,5}\]|\.(?:content|type|text|image_url|image|detail|name|parameters|properties|required|additionalProperties|strict|format|schema|effort|arguments|output|call_id))*$/.test(
    value,
  )
    ? value
    : null;
}

export function readProviderRequestId(headers: Headers): string | null {
  const value = headers.get('x-request-id');
  return value !== null && /^req_[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function describeNetworkFailure(error: unknown): {
  errorType: string;
  networkCode: string | null;
} {
  const nested = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const parsed = NetworkErrorSchema.safeParse(nested);
  const code = parsed.success ? parsed.data.code : null;
  return {
    errorType:
      error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)
        ? error.name
        : 'unknown',
    networkCode: typeof code === 'string' && NetworkErrorCodes.has(code) ? code : null,
  };
}

interface ProviderFailureDiagnostics {
  providerErrorCode: string | null;
  providerErrorType: string | null;
  providerParameter: string | null;
  providerDiagnosticsAvailable: boolean;
}

/** Read bounded error JSON only. Never return raw messages, response text or headers. */
export async function readProviderFailure(response: Response): Promise<ProviderFailureDiagnostics> {
  const unavailable: ProviderFailureDiagnostics = {
    providerErrorCode: null,
    providerErrorType: null,
    providerParameter: null,
    providerDiagnosticsAvailable: false,
  };
  if (!response.body) {
    return unavailable;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > 16 * 1024) {
        await reader.cancel();
        return unavailable;
      }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const parsed = ProviderErrorSchema.safeParse(body);
    if (!parsed.success) {
      return unavailable;
    }
    const { code, type, param } = parsed.data.error;
    const providerErrorCode =
      typeof code === 'string' && ProviderErrorCodes.has(code) ? code : null;
    const providerErrorType =
      typeof type === 'string' && ProviderErrorTypes.has(type) ? type : null;
    const providerParameter = readProviderParameter(param);
    return {
      providerErrorCode,
      providerErrorType,
      providerParameter,
      providerDiagnosticsAvailable:
        providerErrorCode !== null || providerErrorType !== null || providerParameter !== null,
    };
  } catch {
    return unavailable;
  } finally {
    reader.releaseLock();
  }
}
