import { expect, it } from 'vitest';
import OpenAI from 'openai';
import { GuidanceReason, type GuidanceReason as Reason } from '#contracts/CursorCompanion.js';
import {
  describeTeachingFailure,
  canRetryTeachingModelRequest,
  readTeachingModelRetryReason,
  TeachingModelRetryReason,
} from '../../../../src/desktop/worker/teaching/TeachingFailure.js';
import { GuidanceTaskError } from '../../../../src/desktop/worker/teaching/GuidanceTaskError.js';

it('preserves SDK HTTP status through a tool error without logging its private body', () => {
  const sdkError = Object.assign(new Error('private response containing screenshot and key'), {
    status: 502,
    request_id: null,
    code: null,
  });
  const wrapped = new Error('private tool arguments', { cause: sdkError });
  const diagnostic = describeTeachingFailure(wrapped);
  expect(diagnostic).toMatchObject({
    errorCode: 'model_http_error',
    httpStatus: 502,
    causeDepth: 1,
  });
  expect(JSON.stringify(diagnostic)).not.toContain('private');
});

it('rejects unrecognized gateway prose and strips unknown fields from safe diagnostics', () => {
  const diagnostics = {
    gatewayRequestId: 'req-test',
    reason: 'provider_network_failed',
    attemptNumber: 1,
    durationMs: 30,
    networkCode: 'EPIPE',
    message: 'private key',
  };
  const error = Object.assign(new Error('private SDK prose'), {
    status: 502,
    error: { diagnostics },
  });
  expect(describeTeachingFailure(error)).toMatchObject({
    gatewayFailure: { networkCode: 'EPIPE' },
  });
  expect(JSON.stringify(describeTeachingFailure(error))).not.toContain('private');
  error.error.diagnostics.networkCode = 'private arbitrary code';
  expect(describeTeachingFailure(error)).not.toHaveProperty('gatewayFailure');
});

it('offers retry for access errors and validated gateway failures without admitting unknown HTTP errors', () => {
  const diagnostics = {
    gatewayRequestId: 'req-test',
    reason: 'provider_network_failed',
    attemptNumber: 2,
    durationMs: 560,
    networkCode: 'EPIPE',
  };
  const network = Object.assign(new Error('private'), { status: 502, error: { diagnostics } });
  expect(canRetryTeachingModelRequest(new Error('wrapped', { cause: network }))).toBe(true);
  for (const status of [401, 429]) {
    expect(canRetryTeachingModelRequest(Object.assign(new Error(), { status }))).toBe(true);
  }
  for (const status of [400, 403, 500, 502]) {
    expect(canRetryTeachingModelRequest(Object.assign(new Error(), { status }))).toBe(false);
  }
  expect(
    canRetryTeachingModelRequest(
      Object.assign(new Error(), {
        status: 502,
        error: { diagnostics: { ...diagnostics, reason: 'provider_rejected' } },
      }),
    ),
  ).toBe(false);
  expect(
    canRetryTeachingModelRequest(
      Object.assign(new Error(), {
        status: 502,
        error: { diagnostics: { ...diagnostics, networkCode: 'unrecognized' } },
      }),
    ),
  ).toBe(false);
});

it.each([
  new OpenAI.APIConnectionError({
    message: 'private SDK message',
    cause: new Error('private URL and credential'),
  }),
  new OpenAI.APIConnectionTimeoutError({ message: 'private timeout details' }),
])('preserves a lesson after a real SDK transport failure: %s', (sdkError) => {
  const wrapped = new Error('private tool arguments', { cause: sdkError });
  expect(readTeachingModelRetryReason(wrapped)).toBe(
    TeachingModelRetryReason.CONNECTION_INTERRUPTED,
  );
  expect(canRetryTeachingModelRequest(wrapped)).toBe(true);
  expect(describeTeachingFailure(wrapped)).toMatchObject({
    errorType:
      sdkError instanceof OpenAI.APIConnectionTimeoutError
        ? 'APIConnectionTimeoutError'
        : 'APIConnectionError',
    errorCode:
      sdkError instanceof OpenAI.APIConnectionTimeoutError
        ? 'model_connection_timeout'
        : 'model_connection_error',
    causeDepth: 1,
    errorMessageAvailable: false,
  });
  expect(JSON.stringify(describeTeachingFailure(wrapped))).not.toContain('private');
});

it.each([500, 502, 503, 504])(
  'preserves a lesson for a validated temporary provider HTTP%s response',
  (providerStatus) => {
    const diagnostics = {
      gatewayRequestId: 'req-test',
      reason: 'provider_rejected',
      providerStatus,
      attemptNumber: 1,
      durationMs: 100,
      providerErrorCode: 'server_error',
    };
    const sdkError = new OpenAI.InternalServerError(
      502,
      { diagnostics, message: 'private provider message' },
      'private response details',
      new Headers({ 'x-request-id': 'req_gateway-test' }),
    );
    expect(readTeachingModelRetryReason(sdkError)).toBe(
      TeachingModelRetryReason.SERVICE_UNAVAILABLE,
    );
    expect(describeTeachingFailure(sdkError)).toMatchObject({
      httpStatus: 502,
      sdkRequestId: 'req_gateway-test',
      gatewayFailure: { reason: 'provider_rejected', providerStatus },
    });
    expect(JSON.stringify(describeTeachingFailure(sdkError))).not.toContain('private');
  },
);

it.each([400, 401, 403, 404, 422, 429, 501])(
  'keeps provider HTTP%s terminal when it is not an admitted temporary service failure',
  (providerStatus) => {
    const error = new OpenAI.InternalServerError(
      502,
      {
        diagnostics: {
          gatewayRequestId: 'req-test',
          reason: 'provider_rejected',
          providerStatus,
          attemptNumber: 1,
          durationMs: 10,
        },
      },
      'private',
      new Headers(),
    );
    expect(readTeachingModelRetryReason(error)).toBeNull();
  },
);

it('keeps cancellation, native failure, malformed diagnostics and lookalike SDK errors terminal', () => {
  const cancellation = new OpenAI.APIUserAbortError({ message: 'private cancellation' });
  const canceledWrapper = new Error('private wrapper', { cause: cancellation });
  expect(canRetryTeachingModelRequest(canceledWrapper)).toBe(false);
  expect(describeTeachingFailure(canceledWrapper)).toMatchObject({
    errorType: 'APIUserAbortError',
    errorCode: 'model_request_canceled',
  });
  const nativeReasons: Reason[] = [
    GuidanceReason.EXPLICIT_STOP,
    GuidanceReason.RENDER_TIMEOUT,
    GuidanceReason.TRANSPORT_FAILED,
  ];
  for (const reason of nativeReasons) {
    const native = Object.assign(new GuidanceTaskError(reason), {
      cause: new OpenAI.APIConnectionError({}),
    });
    expect(canRetryTeachingModelRequest(new Error('wrapper', { cause: native }))).toBe(false);
  }
  expect(
    canRetryTeachingModelRequest(
      Object.assign(new Error('private lookalike'), { name: 'APIConnectionError' }),
    ),
  ).toBe(false);
  const invalid = new OpenAI.InternalServerError(
    502,
    {
      diagnostics: {
        gatewayRequestId: 'req-test',
        reason: 'provider_rejected',
        providerStatus: 503,
        attemptNumber: 1,
        durationMs: 10,
        networkCode: 'private invalid code',
      },
    },
    'private',
    new Headers(),
  );
  expect(canRetryTeachingModelRequest(invalid)).toBe(false);
});

it('does not offer model retry after a diagnosed client disconnect', () => {
  for (const details of [{ abortSource: 'client' }, { failureStage: 'client_disconnected' }]) {
    const error = new OpenAI.InternalServerError(
      502,
      {
        diagnostics: {
          gatewayRequestId: 'req-test',
          reason: 'provider_network_failed',
          attemptNumber: 1,
          durationMs: 10,
          ...details,
        },
      },
      'private',
      new Headers(),
    );
    expect(canRetryTeachingModelRequest(error)).toBe(false);
  }
});
