import { describe, expect, it } from 'vitest';
import {
  describeNetworkFailure,
  readProviderFailure,
  readProviderRequestId,
} from './ModelGatewayDiagnostics.js';

describe('safe model gateway diagnostics', () => {
  it.each([
    JSON.stringify({
      error: {
        code: 'private-code',
        type: 'private-type',
        param: 'private-param',
        message: 'private prompt',
      },
    }),
    '<html>private failure page</html>',
    JSON.stringify({ error: { code: 'invalid_value', message: 'private '.repeat(5000) } }),
  ])('omits unrecognized, malformed and oversized diagnostics', async (body) => {
    const diagnostics = await readProviderFailure(new Response(body, { status: 400 }));
    expect(diagnostics).toEqual({
      providerErrorCode: null,
      providerErrorType: null,
      providerParameter: null,
      providerDiagnosticsAvailable: false,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private');
  });

  it('contains error-body read failures so diagnostics cannot change the gateway response', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private read failure'));
      },
    });
    expect(await readProviderFailure(new Response(body, { status: 500 }))).toMatchObject({
      providerDiagnosticsAvailable: false,
    });
  });

  it('logs only recognized request IDs and network error categories', () => {
    expect(readProviderRequestId(new Headers({ 'x-request-id': 'req_synthetic-123' }))).toBe(
      'req_synthetic-123',
    );
    expect(readProviderRequestId(new Headers({ 'x-request-id': 'private content' }))).toBeNull();
    expect(
      describeNetworkFailure(new TypeError('private', { cause: { code: 'ENOTFOUND' } })),
    ).toEqual({ errorType: 'TypeError', networkCode: 'ENOTFOUND' });
    expect(describeNetworkFailure(new Error('private', { cause: { code: 'private' } }))).toEqual({
      errorType: 'unknown',
      networkCode: null,
    });
  });
});
