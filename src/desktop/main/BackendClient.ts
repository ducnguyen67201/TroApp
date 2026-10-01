import { setTimeout as delay } from 'node:timers/promises';
import type { ZodType } from 'zod';
import {
  AuthStateSchema,
  GoogleSignInStartSchema,
  HandoffExchangeResponseSchema,
  WorkspaceCreateRequestSchema,
  type AuthState,
} from '#contracts/Auth.js';
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

async function fetchValidated<T>(
  url: URL,
  schema: ZodType<T>,
  init: RequestInit,
  fetchResponse: typeof fetch,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const response = await fetchResponse(url, {
    ...init,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error('The backend could not complete the request.');
  }

  return schema.parse(await response.json());
}

function createAuthorization(sessionToken: string): { authorization: string } {
  return { authorization: `Bearer ${sessionToken}` };
}

export async function startGoogleSignIn(
  apiBaseUrl: string,
  fetchResponse: typeof fetch = fetch,
): Promise<string> {
  const result = await fetchValidated(
    new URL('/api/v1/auth/google/start', apiBaseUrl),
    GoogleSignInStartSchema,
    { method: 'POST' },
    fetchResponse,
  );
  const authorizeUrl = new URL(result.authorizeUrl);

  if (authorizeUrl.protocol !== 'https:' || authorizeUrl.hostname !== 'accounts.google.com') {
    throw new Error('The backend returned an invalid sign-in destination.');
  }

  return authorizeUrl.href;
}

export async function exchangeAuthHandoff(
  apiBaseUrl: string,
  code: string,
  fetchResponse: typeof fetch = fetch,
) {
  return fetchValidated(
    new URL('/api/v1/auth/handoff', apiBaseUrl),
    HandoffExchangeResponseSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    },
    fetchResponse,
  );
}

export async function fetchAuthState(
  apiBaseUrl: string,
  sessionToken: string,
  fetchResponse: typeof fetch = fetch,
): Promise<AuthState> {
  return fetchValidated(
    new URL('/api/v1/auth/session', apiBaseUrl),
    AuthStateSchema,
    { method: 'GET', headers: createAuthorization(sessionToken) },
    fetchResponse,
  );
}

export async function createWorkspace(
  apiBaseUrl: string,
  sessionToken: string,
  displayName: string,
  fetchResponse: typeof fetch = fetch,
): Promise<AuthState> {
  const body = WorkspaceCreateRequestSchema.parse({ displayName });

  return fetchValidated(
    new URL('/api/v1/workspaces', apiBaseUrl),
    AuthStateSchema,
    {
      method: 'POST',
      headers: { ...createAuthorization(sessionToken), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchResponse,
  );
}

export async function revokeSession(
  apiBaseUrl: string,
  sessionToken: string,
  fetchResponse: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchResponse(new URL('/api/v1/auth/logout', apiBaseUrl), {
    method: 'POST',
    headers: createAuthorization(sessionToken),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error('The backend could not complete the request.');
  }
}
