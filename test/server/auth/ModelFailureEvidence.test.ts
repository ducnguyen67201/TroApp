import { describe, expect, it } from 'vitest';
import {
  ModelAbortSource,
  ModelConnectionUse,
  ModelFailureStage,
  type ModelFailureEvidence,
} from '#contracts/ModelGatewayError.js';
import {
  ModelTransportStage,
  type ModelTransportSnapshot,
} from '#contracts/ModelTransportDiagnostics.js';
import { describeModelFailureEvidence } from '../../../src/server/auth/ModelFailureEvidence.js';

const ConnectionFixtures: ReadonlyArray<{
  overrides: Partial<ModelTransportSnapshot>;
  expectedUse: ModelFailureEvidence['connectionUse'];
}> = [
  {
    overrides: { connectionStarted: true, connectionObservedRequestCount: 1 },
    expectedUse: ModelConnectionUse.NEW,
  },
  {
    overrides: { connectionStarted: false, connectionObservedRequestCount: 2 },
    expectedUse: ModelConnectionUse.REUSED,
  },
  {
    overrides: { connectionStarted: true, connectionObservedRequestCount: 2 },
    expectedUse: ModelConnectionUse.REUSED,
  },
  {
    overrides: {
      connectionStarted: false,
      connectionObservedRequestCount: 1,
      socketHadPriorTraffic: true,
    },
    expectedUse: ModelConnectionUse.UNKNOWN,
  },
  {
    overrides: { connectionStarted: false, socketHadPriorTraffic: true },
    expectedUse: ModelConnectionUse.UNKNOWN,
  },
];

function createTransportSnapshot(
  overrides: Partial<ModelTransportSnapshot> = {},
): ModelTransportSnapshot {
  return {
    transportObserved: true,
    lastTransportStage: ModelTransportStage.REQUEST_CREATED,
    connectionStarted: false,
    connectionEstablished: false,
    socketAssigned: false,
    requestBodySent: false,
    providerHeadersReceived: false,
    socketHadPriorTraffic: null,
    socketBytesWrittenSinceAssignment: null,
    socketBytesReadSinceAssignment: null,
    tlsAuthorized: null,
    tlsProtocol: null,
    ...overrides,
  };
}

describe('model failure evidence', () => {
  it('keeps missing observations unknown instead of inferring a connection failure', () => {
    expect(describeModelFailureEvidence({ reason: 'provider_network_failed' })).toEqual({
      failureStage: ModelFailureStage.UNOBSERVED,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
    expect(
      describeModelFailureEvidence({
        transport: createTransportSnapshot({
          transportObserved: false,
          socketAssigned: true,
          connectionStarted: true,
          connectionObservedRequestCount: 3,
        }),
      }),
    ).toEqual({
      failureStage: ModelFailureStage.UNOBSERVED,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it('locates an observed setup failure before assignment without attributing its cause', () => {
    expect(
      describeModelFailureEvidence({
        reason: 'provider_network_failed',
        transport: createTransportSnapshot({
          lastTransportStage: ModelTransportStage.CONNECTION_FAILED,
          connectionStarted: true,
          tlsAuthorized: false,
        }),
      }),
    ).toEqual({
      failureStage: ModelFailureStage.BEFORE_CONNECTION,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it.each([
    { requestBodySent: false, expectedStage: ModelFailureStage.UPLOAD },
    { requestBodySent: true, expectedStage: ModelFailureStage.WAITING_FOR_HEADERS },
  ])(
    'uses local body completion to distinguish upload from waiting for headers: $requestBodySent',
    ({ requestBodySent, expectedStage }) => {
      const result = describeModelFailureEvidence({
        reason: 'provider_network_failed',
        transport: createTransportSnapshot({
          lastTransportStage: ModelTransportStage.REQUEST_FAILED,
          connectionEstablished: true,
          socketAssigned: true,
          requestBodySent,
          socketPeerEnded: true,
          socketClosed: true,
          socketCloseHadError: false,
          socketBytesWrittenSinceAssignment: 65_536,
        }),
      });
      expect(result).toEqual({
        failureStage: expectedStage,
        connectionUse: ModelConnectionUse.UNKNOWN,
      });
    },
  );

  it('treats local bytes submitted as upload evidence without claiming peer receipt', () => {
    expect(
      describeModelFailureEvidence({
        transport: createTransportSnapshot({
          socketAssigned: true,
          requestBodySent: false,
          requestBodyBytesSubmitted: 1_000_000,
          socketBytesWrittenSinceAssignment: 1_000_000,
          socketPendingWriteBytes: 0,
        }),
      }),
    ).toEqual({
      failureStage: ModelFailureStage.UPLOAD,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it('keeps a late body-sent callback after socket closure in the upload stage', () => {
    expect(
      describeModelFailureEvidence({
        transport: createTransportSnapshot({
          socketAssigned: true,
          requestBodySent: true,
          requestBodySentAfterSocketClosed: true,
          socketClosed: true,
          socketBytesWrittenSinceAssignment: 6_291_844,
          lastTransportStage: ModelTransportStage.BODY_SENT,
        }),
      }),
    ).toEqual({
      failureStage: ModelFailureStage.UPLOAD,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it('retains actual header evidence even when upload completion was not observed', () => {
    expect(
      describeModelFailureEvidence({
        transport: createTransportSnapshot({
          socketAssigned: true,
          requestBodySent: false,
          providerHeadersReceived: true,
        }),
      }),
    ).toEqual({
      failureStage: ModelFailureStage.PROVIDER_RESPONSE,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it('retains header arrival even when the last observed event is a later request failure', () => {
    expect(
      describeModelFailureEvidence({
        transport: createTransportSnapshot({
          socketAssigned: true,
          requestBodySent: true,
          providerHeadersReceived: true,
          lastTransportStage: ModelTransportStage.REQUEST_FAILED,
        }),
      }),
    ).toEqual({
      failureStage: ModelFailureStage.PROVIDER_RESPONSE,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it.each([200, 401, 429, 502])(
    'uses actual provider status %i as response evidence without transport observations',
    (providerStatus) => {
      expect(describeModelFailureEvidence({ providerStatus })).toEqual({
        failureStage: ModelFailureStage.PROVIDER_RESPONSE,
        connectionUse: ModelConnectionUse.UNKNOWN,
      });
    },
  );

  it('identifies an interrupted response stream separately from a pre-header gateway failure', () => {
    expect(describeModelFailureEvidence({ providerStatus: 200, streamFailed: true })).toEqual({
      failureStage: ModelFailureStage.RESPONSE_STREAM,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it('gives explicit cancellation and deadline evidence priority over secondary stream errors', () => {
    expect(
      describeModelFailureEvidence({
        reason: 'client_disconnected',
        timedOut: true,
        streamFailed: true,
        providerStatus: 200,
      }),
    ).toEqual({
      failureStage: ModelFailureStage.CLIENT_DISCONNECTED,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
    expect(
      describeModelFailureEvidence({ timedOut: true, streamFailed: true, providerStatus: 200 }),
    ).toEqual({
      failureStage: ModelFailureStage.DEADLINE,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it('preserves the first client abort when the shared deadline expires afterwards', () => {
    expect(
      describeModelFailureEvidence({
        abortSource: ModelAbortSource.CLIENT,
        timedOut: true,
        streamFailed: true,
        providerStatus: 200,
      }),
    ).toEqual({
      failureStage: ModelFailureStage.CLIENT_DISCONNECTED,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it('preserves the first deadline abort when a later socket close reports client disconnection', () => {
    expect(
      describeModelFailureEvidence({
        abortSource: ModelAbortSource.DEADLINE,
        reason: 'client_disconnected',
        timedOut: true,
        streamFailed: true,
        providerStatus: 200,
      }),
    ).toEqual({
      failureStage: ModelFailureStage.DEADLINE,
      connectionUse: ModelConnectionUse.UNKNOWN,
    });
  });

  it.each(ConnectionFixtures)(
    'distinguishes observed new and reused connections conservatively: $expectedUse',
    ({ overrides, expectedUse }) => {
      expect(
        describeModelFailureEvidence({
          transport: createTransportSnapshot({ socketAssigned: true, ...overrides }),
        }),
      ).toEqual({ failureStage: ModelFailureStage.UPLOAD, connectionUse: expectedUse });
    },
  );
});
