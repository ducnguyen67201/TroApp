import { describe, expect, it } from 'vitest';
import { readModelGatewayDiagnostics } from '#contracts/ModelGatewayError.js';

const transport = {
  transportObserved: true,
  lastTransportStage: 'body_sent',
  connectionStarted: true,
  connectionEstablished: true,
  socketAssigned: true,
  requestBodySent: true,
  providerHeadersReceived: false,
  socketHadPriorTraffic: false,
  socketBytesWrittenSinceAssignment: 1234,
  socketBytesReadSinceAssignment: 0,
  tlsAuthorized: true,
  tlsProtocol: 'TLSv1.3',
};

const failure = {
  gatewayRequestId: 'req-synthetic',
  reason: 'provider_network_failed',
  attemptNumber: 2,
  durationMs: 900,
  networkCode: 'EPIPE',
};

describe('desktop transport failure evidence', () => {
  it('retains safe evidence in both HTTP and extracted SDK error envelopes', () => {
    for (const envelope of [
      { diagnostics: { ...failure, transport } },
      { error: { diagnostics: { ...failure, transport } } },
    ]) {
      expect(readModelGatewayDiagnostics(envelope)).toMatchObject({ transport });
    }
  });

  it('discards unknown sensitive fields at the transport boundary', () => {
    const diagnostics = readModelGatewayDiagnostics({
      diagnostics: {
        ...failure,
        transport: {
          ...transport,
          headers: 'private credential',
          address: 'private address',
          body: 'private prompt',
        },
      },
    });
    expect(diagnostics?.transport).toEqual(transport);
    expect(JSON.stringify(diagnostics)).not.toContain('private');
  });

  it.each([
    { socketBytesWrittenSinceAssignment: -1 },
    { socketBytesReadSinceAssignment: Number.MAX_SAFE_INTEGER + 1 },
    { lastTransportStage: 'private text' },
    { tlsProtocol: 'private certificate' },
    { requestBodySent: 'true' },
    { requestBodySentAfterSocketClosed: 'true' },
    { connectionId: 'private host' },
    { connectionObservedDurationMs: -1 },
    { socketPeerEnded: 'true' },
    { socketCloseHadError: 'false' },
    { providerResponseCompleted: 'true' },
    { tlsCipher: 'private cipher' },
    { tlsAlpnProtocol: 'private protocol' },
    { tlsSessionReused: 'true' },
    { connectionSetupDurationMs: -1 },
    { requestBodyBytesSubmitted: -1 },
    { requestBodyChunksSubmitted: 0.5 },
    { requestBodyLargestChunkBytes: Number.MAX_SAFE_INTEGER + 1 },
    { requestBodyFirstWriteAfterAssignmentMs: -1 },
    { requestBodyLastWriteAfterAssignmentMs: 'private timing' },
    { requestBodySentAfterAssignmentMs: -1 },
    { connectionObservedRequestCount: -1 },
    { socketAssignedDurationMs: -1 },
    { socketDrainCountSinceAssignment: -1 },
    { socketLastDrainAfterAssignmentMs: -1 },
    { socketMaximumPendingWriteBytes: -1 },
    { socketPendingWriteBytes: -1 },
    { socketWriteNeedsDrain: 'true' },
    { socketDestroyed: 'true' },
  ])('rejects malformed transport evidence', (fields) => {
    expect(
      readModelGatewayDiagnostics({
        diagnostics: { ...failure, transport: { ...transport, ...fields } },
      }),
    ).toBeNull();
  });

  it('keeps old failure envelopes compatible without transport evidence', () => {
    expect(readModelGatewayDiagnostics({ diagnostics: failure })).toMatchObject(failure);
  });

  it('retains optional TLS and upload evidence without forwarding runtime details or identities', () => {
    const evidence = {
      ...transport,
      lastTransportStage: 'body_write_started',
      tlsCipher: 'TLS_AES_256_GCM_SHA384',
      tlsAlpnProtocol: 'http/1.1',
      tlsSessionReused: true,
      connectionSetupDurationMs: 30,
      connectionObservedRequestCount: 1,
      socketAssignedDurationMs: 400,
      requestBodyBytesSubmitted: 1_500_000,
      requestBodyChunksSubmitted: 1,
      requestBodyLargestChunkBytes: 1_500_000,
      requestBodyFirstWriteAfterAssignmentMs: 1,
      requestBodyLastWriteAfterAssignmentMs: 1,
      requestBodySentAfterAssignmentMs: null,
      socketPendingWriteBytes: 300_000,
      socketMaximumPendingWriteBytes: 1_500_000,
      socketWriteNeedsDrain: true,
      socketDestroyed: false,
      socketDrainCountSinceAssignment: 0,
      socketLastDrainAfterAssignmentMs: null,
    };
    const parsed = readModelGatewayDiagnostics({
      diagnostics: {
        ...failure,
        transport: {
          ...evidence,
          runtimeNodeVersion: 'private runtime',
          session: 'private session',
          certificate: 'private identity',
        },
      },
    });
    expect(parsed?.transport).toEqual(evidence);
    expect(JSON.stringify(parsed)).not.toContain('private');
  });

  it('retains validated connection lifecycle evidence while accepting older snapshots', () => {
    const lifecycle = {
      ...transport,
      lastTransportStage: 'socket_closed',
      connectionId: '00000000-0000-4000-8000-000000000001',
      connectionObservedDurationMs: 50,
      socketPeerEnded: true,
      socketErrorObserved: true,
      socketClosed: true,
      socketCloseHadError: true,
      providerResponseCompleted: false,
    };
    expect(
      readModelGatewayDiagnostics({ diagnostics: { ...failure, transport: lifecycle } })?.transport,
    ).toEqual(lifecycle);
    expect(
      readModelGatewayDiagnostics({ diagnostics: { ...failure, transport } })?.transport,
    ).toEqual(transport);
  });
});
