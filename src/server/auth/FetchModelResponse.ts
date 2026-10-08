import { setTimeout as delay } from 'node:timers/promises';
import { ModelGatewayConfig } from './ModelGatewayConfig.js';
import { describeNetworkFailure } from './ModelGatewayDiagnostics.js';

export const ModelAttemptPhase = {
  STARTED: 'started',
  HEADERS_RECEIVED: 'headers_received',
  FAILED: 'failed',
} as const;

export interface ModelAttemptDiagnostics {
  attemptNumber: number;
  phase: (typeof ModelAttemptPhase)[keyof typeof ModelAttemptPhase];
  durationMs: number;
  aborted: boolean;
  failure?: ReturnType<typeof describeNetworkFailure>;
  retryEligible?: boolean;
  retryDelayMs?: number;
  retryStopReason?: (typeof ModelRetryStopReason)[keyof typeof ModelRetryStopReason];
}

const ModelRetryStopReason = {
  CANCELED: 'canceled',
  ATTEMPTS_EXHAUSTED: 'attempts_exhausted',
  FAILURE_NOT_RETRYABLE: 'failure_not_retryable',
} as const;

const RetryableSocketCodes = new Set<string>(ModelGatewayConfig.retry.socketCodes);

function readModelRetryStopReason(
  aborted: boolean,
  attemptNumber: number,
  networkCode: string | null,
): (typeof ModelRetryStopReason)[keyof typeof ModelRetryStopReason] | undefined {
  if (aborted) {
    return ModelRetryStopReason.CANCELED;
  }
  if (attemptNumber >= ModelGatewayConfig.retry.maximumAttempts) {
    return ModelRetryStopReason.ATTEMPTS_EXHAUSTED;
  }
  if (networkCode === null || !RetryableSocketCodes.has(networkCode)) {
    return ModelRetryStopReason.FAILURE_NOT_RETRYABLE;
  }
  return undefined;
}

/** Retry only rejected fetches before response headers; never replay response streams or tools.
 * A broken connection can leave provider execution uncertain. The one retry is bounded and
 * shares the original deadline; this is not exactly-once inference. */
export async function fetchModelResponse(
  providerKey: string,
  body: string,
  signal: AbortSignal,
  reportRetry: (error: unknown) => void,
  reportAttempt?: (attempt: ModelAttemptDiagnostics) => void,
): Promise<Response> {
  let attemptNumber = 1;
  for (;;) {
    signal.throwIfAborted();
    const startedAt = performance.now();
    reportAttempt?.({
      attemptNumber,
      phase: ModelAttemptPhase.STARTED,
      durationMs: 0,
      aborted: signal.aborted,
    });
    try {
      const response = await fetch(ModelGatewayConfig.providerResponsesUrl, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + providerKey, 'content-type': 'application/json' },
        body,
        signal,
      });
      reportAttempt?.({
        attemptNumber,
        phase: ModelAttemptPhase.HEADERS_RECEIVED,
        durationMs: Math.round(performance.now() - startedAt),
        aborted: signal.aborted,
      });
      return response;
    } catch (error) {
      const failure = describeNetworkFailure(error);
      const retryStopReason = readModelRetryStopReason(
        signal.aborted,
        attemptNumber,
        failure.networkCode,
      );
      reportAttempt?.({
        attemptNumber,
        phase: ModelAttemptPhase.FAILED,
        durationMs: Math.round(performance.now() - startedAt),
        aborted: signal.aborted,
        failure,
        retryEligible: retryStopReason === undefined,
        retryDelayMs: retryStopReason === undefined ? ModelGatewayConfig.retry.delayMs : 0,
        ...(retryStopReason ? { retryStopReason } : {}),
      });
      if (retryStopReason !== undefined) {
        throw error;
      }
      await delay(ModelGatewayConfig.retry.delayMs, undefined, { signal });
      signal.throwIfAborted();
      reportRetry(error);
      signal.throwIfAborted();
      attemptNumber += 1;
    }
  }
}
