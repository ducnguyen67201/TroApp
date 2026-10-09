import {
  ModelAbortSource,
  ModelFailureStage,
  readModelGatewayDiagnostics,
  type ModelGatewayDiagnostics,
} from '#contracts/ModelGatewayError.js';
import { z } from 'zod';
import OpenAI from 'openai';
import { GuidanceReason, type CursorCompanionTool } from '#contracts/CursorCompanion.js';
import type { DesktopObservation, DesktopObservationTool } from '#contracts/DesktopObservation.js';
import { GuidanceTaskError } from './GuidanceTaskError.js';
import type { describeCuaResult } from '../cua/LoggedCuaServer.js';

export const TeachingFailureCode = {
  PRESENTATION_INCOMPLETE: 'presentation_incomplete',
  MODEL_INPUT_INVALID: 'model_input_invalid',
  OBSERVATION_READY_TIMEOUT: 'observation_ready_timeout',
  OBSERVATION_TOOL_FAILED: 'observation_tool_failed',
  OBSERVATION_INVALID_SNAPSHOT: 'observation_invalid_snapshot',
  OBSERVATION_OWNER_MISMATCH: 'observation_owner_mismatch',
  CAPTURE_BASELINE_MISSING: 'capture_baseline_missing',
  COMPANION_RENEWAL_FAILED: 'companion_renewal_failed',
  COMPANION_MODE_FAILED: 'companion_mode_failed',
  COMPANION_MODE_INVALID: 'companion_mode_invalid',
  COMPANION_MODE_NOT_APPLIED: 'companion_mode_not_applied',
} as const;

type FailureCode = (typeof TeachingFailureCode)[keyof typeof TeachingFailureCode];

const TeachingModelErrorCode = {
  HTTP: 'model_http_error',
  CONNECTION: 'model_connection_error',
  TIMEOUT: 'model_connection_timeout',
  CANCELED: 'model_request_canceled',
  UNEXPECTED: 'unexpected_error',
} as const;

export const TeachingModelRetryReason = {
  ACCESS_UNAVAILABLE: 'access_unavailable',
  CONNECTION_INTERRUPTED: 'connection_interrupted',
  SERVICE_UNAVAILABLE: 'service_unavailable',
} as const;

export type TeachingModelRetryReason =
  (typeof TeachingModelRetryReason)[keyof typeof TeachingModelRetryReason];

const temporaryProviderStatuses = new Set([500, 502, 503, 504]);

const FailureMessages = {
  [TeachingFailureCode.PRESENTATION_INCOMPLETE]:
    'The model exhausted presentation repairs without an acknowledged message and required drawing. Teaching cannot wait on a chat-only spatial instruction.',
  [TeachingFailureCode.MODEL_INPUT_INVALID]:
    'The model exhausted the teaching proposal correction limit. Inspect invalidFields for the rejected contract fields.',
  [TeachingFailureCode.OBSERVATION_READY_TIMEOUT]:
    'The native observer accepted the watch but did not report a usable screen frame before the readiness deadline.',
  [TeachingFailureCode.OBSERVATION_TOOL_FAILED]: 'The native desktop watch tool returned an error.',
  [TeachingFailureCode.OBSERVATION_INVALID_SNAPSHOT]:
    'The native desktop watch returned metadata that does not match the observation contract.',
  [TeachingFailureCode.OBSERVATION_OWNER_MISMATCH]:
    'The native desktop watch returned metadata for a different lesson.',
  [TeachingFailureCode.CAPTURE_BASELINE_MISSING]:
    'The model segment ended without a valid screen capture tied to the current desktop watch.',
  [TeachingFailureCode.COMPANION_RENEWAL_FAILED]:
    'The native cursor companion could not renew its following lease. Teaching cannot continue on this transport.',
  [TeachingFailureCode.COMPANION_MODE_FAILED]:
    'The native cursor companion rejected the mode request. Inspect nativeResult for the driver diagnostic.',
  [TeachingFailureCode.COMPANION_MODE_INVALID]:
    'The native cursor companion returned a mode acknowledgement outside its state contract.',
  [TeachingFailureCode.COMPANION_MODE_NOT_APPLIED]:
    'The native cursor companion acknowledged a different following state than requested.',
} satisfies Record<FailureCode, string>;

export const TeachingFailureStage = {
  START_COMPANION: 'start_companion',
  START_OBSERVATION: 'start_observation',
  RUN_MODEL: 'run_model',
  CHECK_MODEL_RESULT: 'check_model_result',
  WAIT_FOR_INPUT: 'wait_for_input',
  WAIT_FOR_STUDENT: 'wait_for_student',
  PAUSE_LESSON: 'pause_lesson',
} as const;

export type TeachingFailureStage = (typeof TeachingFailureStage)[keyof typeof TeachingFailureStage];

interface TeachingFailureDetails {
  timeoutMs?: number;
  elapsedMs?: number;
  pollCount?: number;
  observation?: Omit<DesktopObservation, 'watch_id'>;
  toolName?:
    DesktopObservationTool | (typeof CursorCompanionTool)[keyof typeof CursorCompanionTool];
  requestedMode?: 'follow' | 'hidden';
  nativeResult?: ReturnType<typeof describeCuaResult>;
  invalidFields?: string[];
}

interface TeachingFailureDiagnostics extends TeachingFailureDetails {
  errorType: string;
  errorCode: string;
  errorMessage?: string;
  errorStack?: string;
  reason?: GuidanceReason;
  errorMessageAvailable?: boolean;
  httpStatus?: number;
  gatewayFailure?: ModelGatewayDiagnostics;
  sdkRequestId?: string;
  sdkErrorCode?: string;
  causeDepth?: number;
}

/** Preserve the precise local failure while retaining the public guidance reason.
 * Messages and details are owned diagnostics, never raw native/model payloads. */
export class TeachingFailure extends GuidanceTaskError {
  constructor(
    readonly code: FailureCode,
    reason: GuidanceReason,
    readonly details: TeachingFailureDetails = {},
  ) {
    super(reason);
    this.name = 'TeachingFailure';
    this.message = FailureMessages[code];
  }
}

/** All fields come from a validated snapshot; lesson ownership IDs stay out of logs. */
export function describeTeachingObservation(
  observation: DesktopObservation,
): Omit<DesktopObservation, 'watch_id'> {
  return {
    ready: observation.ready,
    screen_revision: observation.screen_revision,
    input_revision: observation.input_revision,
    changed_fraction: observation.changed_fraction,
    quiet_ms: observation.quiet_ms,
    buttons_down: observation.buttons_down,
    screen_width: observation.screen_width,
    screen_height: observation.screen_height,
  };
}

/** Do not serialize arbitrary Error objects: SDK errors can retain prompts and tokens. */
export function describeTeachingFailure(error: unknown): TeachingFailureDiagnostics {
  if (error instanceof TeachingFailure) {
    return {
      errorType: error.name,
      errorCode: error.code,
      errorMessage: error.message,
      ...(error.stack ? { errorStack: error.stack } : {}),
      reason: error.reason,
      ...error.details,
    };
  }
  if (error instanceof GuidanceTaskError) {
    return { errorType: 'GuidanceTaskError', errorCode: error.reason, reason: error.reason };
  }
  let current: unknown = error;
  const chain: Array<{
    errorType: string;
    errorCode?: (typeof TeachingModelErrorCode)[keyof typeof TeachingModelErrorCode];
    httpStatus?: number;
    gatewayFailure?: ModelGatewayDiagnostics;
    sdkRequestId?: string;
    sdkErrorCode?: string;
    causeDepth: number;
  }> = [];
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof GuidanceTaskError) {
      return { ...describeTeachingFailure(current), causeDepth: depth };
    }
    if (current instanceof OpenAI.APIUserAbortError) {
      chain.push({
        errorType: 'APIUserAbortError',
        errorCode: TeachingModelErrorCode.CANCELED,
        causeDepth: depth,
      });
      break;
    }
    if (current instanceof OpenAI.APIConnectionError) {
      chain.push({
        errorType:
          current instanceof OpenAI.APIConnectionTimeoutError
            ? 'APIConnectionTimeoutError'
            : 'APIConnectionError',
        errorCode:
          current instanceof OpenAI.APIConnectionTimeoutError
            ? TeachingModelErrorCode.TIMEOUT
            : TeachingModelErrorCode.CONNECTION,
        causeDepth: depth,
      });
      break;
    }
    const parsed = z
      .object({
        status: z.number().int().min(100).max(599).optional(),
        requestID: z.unknown().optional(),
        request_id: z.unknown().optional(),
        code: z.unknown().optional(),
        cause: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .safeParse(current);
    if (!parsed.success) {
      break;
    }
    const { status, code } = parsed.data;
    const requestId = parsed.data.requestID ?? parsed.data.request_id;
    if (status !== undefined) {
      const gatewayFailure =
        readModelGatewayDiagnostics(parsed.data.error) ?? readModelGatewayDiagnostics(current);
      chain.push({
        ...(gatewayFailure ? { gatewayFailure } : {}),
        errorType: current instanceof Error ? current.constructor.name : 'SdkResponseError',
        httpStatus: status,
        ...(typeof requestId === 'string' && /^req[_-][A-Za-z0-9_-]{1,128}$/.test(requestId)
          ? { sdkRequestId: requestId }
          : {}),
        ...(typeof code === 'string' &&
        ['server_error', 'rate_limit_exceeded', 'invalid_api_key', 'insufficient_quota'].includes(
          code,
        )
          ? { sdkErrorCode: code }
          : {}),
        causeDepth: depth,
      });
      break;
    }
    current = parsed.data.cause;
  }
  return {
    errorType: error instanceof Error ? error.constructor.name : typeof error,
    errorCode: chain.length ? TeachingModelErrorCode.HTTP : TeachingModelErrorCode.UNEXPECTED,
    errorMessageAvailable: false,
    ...chain[0],
  };
}

/** Preserve the lesson for an explicit student retry, never replaying a stream or tool.
 * SDK connection types establish desktop transport failure. Provider status is trusted
 * only inside the validated Tro gateway diagnostics; arbitrary 502s remain unexplained. */
export function readTeachingModelRetryReason(error: unknown): TeachingModelRetryReason | null {
  const failure = describeTeachingFailure(error);
  if (
    failure.errorCode === TeachingModelErrorCode.CONNECTION ||
    failure.errorCode === TeachingModelErrorCode.TIMEOUT
  ) {
    return TeachingModelRetryReason.CONNECTION_INTERRUPTED;
  }
  if (failure.httpStatus === 401 || failure.httpStatus === 429) {
    return TeachingModelRetryReason.ACCESS_UNAVAILABLE;
  }
  const gatewayFailure = failure.gatewayFailure;
  if (failure.httpStatus !== 502 || !gatewayFailure) {
    return null;
  }
  if (
    gatewayFailure.reason === 'provider_network_failed' &&
    gatewayFailure.abortSource !== ModelAbortSource.CLIENT &&
    gatewayFailure.failureStage !== ModelFailureStage.CLIENT_DISCONNECTED
  ) {
    return TeachingModelRetryReason.CONNECTION_INTERRUPTED;
  }
  if (
    gatewayFailure.reason === 'provider_rejected' &&
    gatewayFailure.providerStatus !== undefined &&
    temporaryProviderStatuses.has(gatewayFailure.providerStatus)
  ) {
    return TeachingModelRetryReason.SERVICE_UNAVAILABLE;
  }
  return null;
}

export function canRetryTeachingModelRequest(error: unknown): boolean {
  return readTeachingModelRetryReason(error) !== null;
}
