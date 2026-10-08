import { describe, expect, it } from 'vitest';
import { describeSocketClose } from '../../../src/server/auth/SocketCloseDiagnostics.js';
import { describeNetworkFailure } from '../../../src/server/auth/ModelGatewayDiagnostics.js';

describe('safe original socket error evidence', () => {
  it.each([
    { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', family: 'tls', reason: 'tls_internal_alert' },
    { code: 'ERR_SSL_TLSV1_ALERT_DECODE_ERROR', family: 'tls', reason: 'tls_decode_alert' },
    { code: 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC', family: 'tls', reason: 'tls_bad_record_mac' },
    { code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC', family: 'tls', reason: 'tls_bad_record_mac' },
    { code: 'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE', family: 'tls', reason: 'unclassified' },
    { code: 'ERR_SSL_APPLICATION_DATA_AFTER_CLOSE_NOTIFY', family: 'tls', reason: 'unclassified' },
    { code: 'ERR_STREAM_WRITE_AFTER_END', family: 'stream', reason: 'unclassified' },
    { code: 'HPE_INVALID_HEADER_TOKEN', family: 'http_parser', reason: 'unclassified' },
    { code: 'EPIPE', family: 'system', reason: 'unclassified' },
  ])('retains native $code without raw error messages', ({ code, family, reason }) => {
    const error = Object.assign(new Error('private certificate and address'), { code });
    expect(describeSocketClose(error)).toEqual({
      socketErrorCode: code,
      socketErrorCodeState: 'recognized',
      socketErrorFamily: family,
      socketErrorName: 'Error',
      socketErrorReason: reason,
      socketErrorCauses: [],
      socketErrorCausesTruncated: false,
      socketTlsErrorNumber: null,
      socketTlsReasonNumber: null,
      socketTlsAlertNumber: null,
    });
    expect(JSON.stringify(describeSocketClose(error))).not.toContain('private');
  });

  it.each([
    { message: 'reset', reason: 'client_reset' },
    { message: 'socket idle timeout', reason: 'client_idle_timeout' },
    { message: 'aborted', reason: 'client_aborted' },
    { message: 'upgrade', reason: 'protocol_upgrade' },
    { message: 'private explanation', reason: 'unclassified' },
  ])('maps only recognized Undici informational reasons: $reason', ({ message, reason }) => {
    const error = Object.assign(new Error(message), {
      code: 'UND_ERR_INFO',
      name: 'InformationalError',
    });
    expect(describeSocketClose(error)).toMatchObject({
      socketErrorCode: 'UND_ERR_INFO',
      socketErrorFamily: 'http_client',
      socketErrorReason: reason,
    });
    expect(JSON.stringify(describeSocketClose(error))).not.toContain('private');
  });

  it.each([
    null,
    'private',
    { code: 'private code', name: 'private name', message: 'private content' },
    { code: 'ERR_SSL_PRIVATE_CREDENTIAL', name: 'private name', message: 'private content' },
  ])('omits unrecognized codes, names, messages and malformed errors', (error) => {
    const diagnostic = describeSocketClose(error);
    expect(diagnostic.socketErrorCode).toBeNull();
    expect(diagnostic.socketErrorName).toBeNull();
    expect(JSON.stringify(diagnostic).toLowerCase()).not.toContain('private');
  });

  it('leaves the existing fetch failure/retry classification unchanged', () => {
    const error = new TypeError('private', {
      cause: { code: 'UND_ERR_INFO', message: 'reset', cause: { code: 'EPIPE' } },
    });
    expect(describeNetworkFailure(error)).toMatchObject({ networkCode: 'EPIPE', causeDepth: 2 });
  });

  it('preserves nested native causes without replacing the original error or exposing content', () => {
    const error = new TypeError('private wrapper', {
      cause: Object.assign(new Error('private HTTP context'), {
        code: 'UND_ERR_INFO',
        cause: Object.assign(new Error('private TLS identity'), {
          code: 'ERR_SSL_TLSV1_ALERT_DECODE_ERROR',
        }),
      }),
    });
    const diagnostic = describeSocketClose(error);
    expect(diagnostic).toMatchObject({
      socketErrorCode: null,
      socketErrorCodeState: 'missing',
      socketErrorName: 'TypeError',
      socketErrorCausesTruncated: false,
      socketErrorCauses: [
        { causeDepth: 1, socketErrorCode: 'UND_ERR_INFO', socketErrorFamily: 'http_client' },
        {
          causeDepth: 2,
          socketErrorCode: 'ERR_SSL_TLSV1_ALERT_DECODE_ERROR',
          socketErrorReason: 'tls_decode_alert',
        },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    expect(describeNetworkFailure(error).networkCode).toBeNull();
  });

  it('distinguishes an omitted unknown code from an error without a code, including nested causes', () => {
    const diagnostic = describeSocketClose({
      code: 'ERR_SSL_PRIVATE_CREDENTIAL',
      message: 'private prompt',
      cause: {
        name: 'private name',
        code: { secret: 'private secret' },
        cause: new Error('private body'),
      },
    });
    expect(diagnostic).toMatchObject({
      socketErrorCode: null,
      socketErrorCodeState: 'unrecognized',
      socketErrorFamily: 'tls',
      socketErrorCauses: [
        { causeDepth: 1, socketErrorCode: null, socketErrorCodeState: 'unrecognized' },
        { causeDepth: 2, socketErrorCode: null, socketErrorCodeState: 'missing' },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });

  it('bounds a long native cause chain to six errors and marks omitted causes', () => {
    let error: unknown = { code: 'EPIPE' };
    for (let depth = 0; depth < 10; depth += 1) {
      error = new Error('private cause', { cause: error });
    }
    const diagnostic = describeSocketClose(error);
    expect(diagnostic.socketErrorCauses.map((cause) => cause.causeDepth)).toEqual([1, 2, 3, 4, 5]);
    expect(diagnostic.socketErrorCausesTruncated).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });

  it('stops a cyclic cause chain without retaining or exposing the native error', () => {
    const error: { code: string; cause?: unknown } = { code: 'UND_ERR_INFO' };
    error.cause = error;
    expect(describeSocketClose(error)).toMatchObject({
      socketErrorCode: 'UND_ERR_INFO',
      socketErrorCauses: [],
      socketErrorCausesTruncated: true,
    });
  });

  it('omits a primitive cause instead of serializing private content', () => {
    const diagnostic = describeSocketClose(new Error('private root', { cause: 'private cause' }));
    expect(diagnostic.socketErrorCauses).toEqual([]);
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });

  it('retains numeric TLS evidence for an unlisted code while omitting raw content', () => {
    const diagnostic = describeSocketClose({
      code: 'ERR_SSL_PRIVATE_CREDENTIAL',
      name: 'Error',
      library: 'SSL routines',
      message: 'private:error:0A000126:SSL routines:private TLS context',
      cause: {
        code: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
        library: 'SSL routines',
        message: 'private:error:0A0003FC:SSL routines:private TLS context',
      },
    });
    expect(diagnostic).toMatchObject({
      socketErrorCode: null,
      socketErrorCodeState: 'unrecognized',
      socketTlsErrorNumber: '0A000126',
      socketTlsReasonNumber: 294,
      socketTlsAlertNumber: null,
      socketErrorCauses: [
        {
          causeDepth: 1,
          socketErrorCodeState: 'recognized',
          socketTlsErrorNumber: '0A0003FC',
          socketTlsAlertNumber: 20,
        },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });
});
