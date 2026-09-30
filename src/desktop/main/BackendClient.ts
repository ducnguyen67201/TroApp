import { setTimeout as delay } from 'node:timers/promises';
import { SystemStatusSchema, type SystemStatus } from '#contracts/SystemStatus.js';

const REQUEST_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 200;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/* Only this read-only GET is retried. Fetch rejections and temporary gateway
   responses get one more attempt; writes need their own idempotency policy. */
async function fetchStatusResponse(url: URL, fetchResponse: typeof fetch): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchResponse(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });

      if (attempt === 1 || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
    } catch {
      if (attempt === 1) {
        throw new Error('The backend is unavailable.');
      }
    }

    await delay(RETRY_DELAY_MS);
  }

  throw new Error('The backend is unavailable.');
}

/** Fetches status with one bounded retry and validates the response contract. */
export async function fetchServiceStatus(
  apiBaseUrl: string,
  fetchResponse: typeof fetch = fetch,
): Promise<SystemStatus> {
  const response = await fetchStatusResponse(
    new URL('/api/v1/system/status', apiBaseUrl),
    fetchResponse,
  );

  if (!response.ok) {
    throw new Error('The backend is unavailable.');
  }

  return SystemStatusSchema.parse(await response.json());
}
