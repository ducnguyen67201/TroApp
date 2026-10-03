import { setTimeout as delay } from 'node:timers/promises';
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
}

export const ModelGatewayRetry = { MAXIMUM_ATTEMPTS: 2, DELAY_MS: 250 } as const;

const RetryableSocketCodes = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

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
      const response = await fetch('https://api.openai.com/v1/responses', {
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
      reportAttempt?.({
        attemptNumber,
        phase: ModelAttemptPhase.FAILED,
        durationMs: Math.round(performance.now() - startedAt),
        aborted: signal.aborted,
        failure: describeNetworkFailure(error),
      });
      const code = describeNetworkFailure(error).networkCode;
      if (
        signal.aborted ||
        attemptNumber >= ModelGatewayRetry.MAXIMUM_ATTEMPTS ||
        code === null ||
        !RetryableSocketCodes.has(code)
      ) {
        throw error;
      }
      await delay(ModelGatewayRetry.DELAY_MS, undefined, { signal });
      signal.throwIfAborted();
      reportRetry(error);
      signal.throwIfAborted();
      attemptNumber += 1;
    }
  }
}
