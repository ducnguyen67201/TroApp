import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { readTlsErrorNumbers } from '../../../src/server/auth/TlsErrorDiagnostics.js';
import { describeSocketClose } from '../../../src/server/auth/SocketCloseDiagnostics.js';

describe('bounded numeric OpenSSL error evidence', () => {
  it.each([
    { packedNumber: '0A0003FC', reasonNumber: 1020, alertNumber: 20 },
    { packedNumber: '0a000410', reasonNumber: 1040, alertNumber: 40 },
    { packedNumber: '0A000126', reasonNumber: 294, alertNumber: null },
    { packedNumber: '0A000123', reasonNumber: 291, alertNumber: null },
  ])(
    'extracts only the packed SSL token $packedNumber',
    ({ packedNumber, reasonNumber, alertNumber }) => {
      const diagnostic = readTlsErrorNumbers({
        library: 'SSL routines',
        message: `private address:error:${packedNumber}:SSL routines:private source and context`,
      });
      expect(diagnostic).toEqual({
        socketTlsErrorNumber: packedNumber.toUpperCase(),
        socketTlsReasonNumber: reasonNumber,
        socketTlsAlertNumber: alertNumber,
      });
      expect(JSON.stringify(diagnostic)).not.toContain('private');
    },
  );

  it.each([
    null,
    'private',
    { message: 'error:0A0003FC:SSL routines:private' },
    { library: 'private library', message: 'error:0A0003FC:SSL routines:private' },
    { library: 'SSL routines', message: 'error:0B0003FC:SSL routines:private' },
    { library: 'SSL routines', message: 'error:0A0003FC1:SSL routines:private' },
    { library: 'SSL routines', message: 'error:0A003FC:SSL routines:private' },
    { library: 'SSL routines', message: 'error:0A0003FC:private library:private' },
    {
      library: 'SSL routines',
      message: 'private '.repeat(600) + ':error:0A0003FC:SSL routines:private',
    },
  ])('omits malformed, non-SSL or out-of-bound message evidence', (error) => {
    expect(readTlsErrorNumbers(error)).toEqual({
      socketTlsErrorNumber: null,
      socketTlsReasonNumber: null,
      socketTlsAlertNumber: null,
    });
  });
});

describe('native TLS alert evidence', () => {
  it.each([
    {
      alertNumber: 20,
      currentCode: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
      legacyCode: 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
      packedNumber: '0A0003FC',
    },
    {
      alertNumber: 40,
      currentCode: 'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE',
      legacyCode: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
      packedNumber: '0A000410',
    },
  ])(
    'retains the original error when a real local peer sends fatal TLS alert $alertNumber',
    async ({ alertNumber, currentCode, legacyCode, packedNumber }) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        /* A TLS alert record before ServerHello needs no certificate or provider.
         * Type 21, TLS record version 3.3, two bytes: fatal (2), alert description. */
        socket.once('data', () => socket.end(Buffer.from([21, 3, 3, 0, 2, 2, alertNumber])));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected a local TCP test listener.');
        }
        let failure: unknown;
        try {
          await fetch(`https://127.0.0.1:${String(address.port)}`);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(TypeError);
        const summary = describeSocketClose(failure);
        const original = summary.socketErrorCauses.find(
          (cause) => cause.socketErrorFamily === 'tls',
        );
        expect([currentCode, legacyCode]).toContain(original?.socketErrorCode);
        expect(original).toMatchObject({
          socketErrorCodeState: 'recognized',
          socketErrorFamily: 'tls',
          socketTlsErrorNumber: packedNumber,
          socketTlsReasonNumber: 1000 + alertNumber,
          socketTlsAlertNumber: alertNumber,
        });
        expect(JSON.stringify(summary)).not.toContain('127.0.0.1');
        expect(JSON.stringify(summary)).not.toContain('SSL routines:');
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    },
  );
});
