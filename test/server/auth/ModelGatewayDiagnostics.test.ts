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

it('retains safe socket closure and byte counters without addresses or arbitrary messages', () => {
  const diagnostics = describeNetworkFailure(
    new TypeError('private provider URL', {
      cause: {
        code: 'UND_ERR_SOCKET',
        message: 'other side closed',
        socket: {
          bytesWritten: 1984000,
          bytesRead: 0,
          remoteAddress: 'private address',
          localPort: 12345,
        },
      },
    }),
  );
  expect(diagnostics).toMatchObject({
    networkCode: 'UND_ERR_SOCKET',
    socketFailureReason: 'peer_closed',
    socketBytesWritten: 1984000,
    socketBytesRead: 0,
  });
  expect(JSON.stringify(diagnostics)).not.toContain('private');
  expect(JSON.stringify(diagnostics)).not.toContain('localPort');
});

it.each([-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 'private counter'])(
  'omits malformed socket counters (%s) and arbitrary socket messages',
  (value) => {
    const diagnostics = describeNetworkFailure(
      new TypeError('private', {
        cause: {
          code: 'UND_ERR_SOCKET',
          message: 'private credential and prompt',
          socket: { bytesWritten: value, bytesRead: value },
        },
      }),
    );
    expect(diagnostics).toMatchObject({
      socketFailureReason: 'unclassified',
      socketBytesWritten: null,
      socketBytesRead: null,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private');
  },
);
