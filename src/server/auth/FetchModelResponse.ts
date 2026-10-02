import { setTimeout as delay } from 'node:timers/promises';
import { describeNetworkFailure } from './ModelGatewayDiagnostics.js';

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
): Promise<Response> {
  let attemptNumber = 1;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + providerKey, 'content-type': 'application/json' },
        body,
        signal,
      });
    } catch (error) {
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
