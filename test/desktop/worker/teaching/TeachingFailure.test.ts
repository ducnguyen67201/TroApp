import { expect, it } from 'vitest';
import { describeTeachingFailure } from '../../../../src/desktop/worker/teaching/TeachingFailure.js';

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
