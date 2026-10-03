import { describe, expect, it } from 'vitest';
import {
  describeNetworkFailure,
  readProviderFailure,
  readProviderRequestId,
} from '../../../src/server/auth/ModelGatewayDiagnostics.js';

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
    ).toMatchObject({ errorType: 'TypeError', networkCode: 'ENOTFOUND', causeDepth: 1 });
    expect(
      describeNetworkFailure(new Error('private', { cause: { code: 'private' } })),
    ).toMatchObject({
      errorType: 'unknown',
      networkCode: null,
    });
  });
});

it('reports nested broken-pipe operation and errno without raw messages or addresses', () => {
  const error = new TypeError('private URL', {
    cause: new Error('private socket', {
      cause: {
        code: 'EPIPE',
        syscall: 'write',
        errno: -32,
        address: 'private address',
        message: 'private secret',
      },
    }),
  });
  const diagnostic = describeNetworkFailure(error);
  expect(diagnostic).toEqual({
    errorType: 'TypeError',
    networkCode: 'EPIPE',
    networkSyscall: 'write',
    networkErrno: -32,
    causeDepth: 2,
  });
  expect(JSON.stringify(diagnostic)).not.toContain('private');
});
