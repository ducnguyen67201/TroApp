import OpenAI from 'openai';
import { z } from 'zod';

const FailureCategory = {
  API: 'api',
  TRANSPORT: 'transport',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  RESPONSE: 'response',
  UNKNOWN: 'unknown',
} as const;
const ProviderIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const ProviderParameterSchema = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*|\[\d{1,6}\]){0,8}$/);
const TransportCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const HttpStatusSchema = z.number().int().min(400).max(599);
const MaximumCauseDepth = 4;

export interface RemotionProviderFailure {
  category: (typeof FailureCategory)[keyof typeof FailureCategory];
  httpStatus: number | null;
  providerCode: string | null;
  providerType: string | null;
  providerParam: string | null;
  transportCode: string | null;
  aborted: boolean;
}

/** Expose only validated protocol identifiers; never copy error messages, bodies, headers, or configuration. */
export function readRemotionProviderFailure(
  error: unknown,
  signal: AbortSignal,
  providerResponded: boolean,
): RemotionProviderFailure {
  const aborted = signal.aborted || error instanceof OpenAI.APIUserAbortError;
  const transportCode = readTransportCauseCode(error);
  let category: RemotionProviderFailure['category'] = providerResponded
    ? FailureCategory.RESPONSE
    : FailureCategory.UNKNOWN;
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    category = FailureCategory.TIMEOUT;
  } else if (aborted) {
    category = FailureCategory.ABORTED;
  } else if (error instanceof OpenAI.APIConnectionError || transportCode !== null) {
    category = FailureCategory.TRANSPORT;
  } else if (error instanceof OpenAI.APIError) {
    category = FailureCategory.API;
  }
  const apiError = error instanceof OpenAI.APIError ? error : null;
  const httpStatus = HttpStatusSchema.safeParse(apiError?.status);
  const providerCode = ProviderIdentifierSchema.safeParse(apiError?.code);
  const providerType = ProviderIdentifierSchema.safeParse(apiError?.type);
  const providerParam = ProviderParameterSchema.safeParse(apiError?.param);
  return {
    category,
    httpStatus: httpStatus.success ? httpStatus.data : null,
    providerCode: providerCode.success ? providerCode.data : null,
    providerType: providerType.success ? providerType.data : null,
    providerParam: providerParam.success ? providerParam.data : null,
    transportCode,
    aborted,
  };
}

function readTransportCauseCode(error: unknown): string | null {
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < MaximumCauseDepth; depth += 1) {
    if (typeof cause !== 'object' || cause === null) {
      return null;
    }
    const code = TransportCodeSchema.safeParse('code' in cause ? cause.code : undefined);
    if (code.success) {
      return code.data;
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return null;
}
