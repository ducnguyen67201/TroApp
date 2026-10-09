import {
  ModelConnectionUse,
  ModelAbortSource,
  ModelFailureStage,
  type ModelFailureEvidence,
  type ModelGatewayDiagnostics,
} from '#contracts/ModelGatewayError.js';

export interface ModelFailureEvidenceInput {
  reason?: ModelGatewayDiagnostics['reason'];
  timedOut?: boolean;
  providerStatus?: number;
  transport?: ModelGatewayDiagnostics['transport'];
  streamFailed?: boolean;
  abortSource?: ModelGatewayDiagnostics['abortSource'];
}

/** Locate an observed failure, without attributing a closure to a remote actor.
 * Body completion is a local write event; it does not establish provider receipt. */
export function describeModelFailureEvidence(
  input: ModelFailureEvidenceInput,
): ModelFailureEvidence {
  const transport = input.transport;
  const connectionUse =
    !transport?.transportObserved || !transport.socketAssigned
      ? ModelConnectionUse.UNKNOWN
      : (transport.connectionObservedRequestCount ?? 0) > 1
        ? ModelConnectionUse.REUSED
        : transport.connectionStarted
          ? ModelConnectionUse.NEW
          : ModelConnectionUse.UNKNOWN;
  let failureStage: ModelFailureEvidence['failureStage'];
  if (input.abortSource === ModelAbortSource.CLIENT) {
    failureStage = ModelFailureStage.CLIENT_DISCONNECTED;
  } else if (input.abortSource === ModelAbortSource.DEADLINE) {
    failureStage = ModelFailureStage.DEADLINE;
  } else if (input.reason === 'client_disconnected') {
    failureStage = ModelFailureStage.CLIENT_DISCONNECTED;
  } else if (input.timedOut) {
    failureStage = ModelFailureStage.DEADLINE;
  } else if (input.streamFailed) {
    failureStage = ModelFailureStage.RESPONSE_STREAM;
  } else if (input.providerStatus !== undefined) {
    failureStage = ModelFailureStage.PROVIDER_RESPONSE;
  } else if (!transport?.transportObserved) {
    failureStage = ModelFailureStage.UNOBSERVED;
  } else if (transport.providerHeadersReceived) {
    failureStage = ModelFailureStage.PROVIDER_RESPONSE;
  } else if (!transport.socketAssigned) {
    failureStage = ModelFailureStage.BEFORE_CONNECTION;
  } else if (!transport.requestBodySent || transport.requestBodySentAfterSocketClosed === true) {
    /* Undici can emit bodySent after the write failed and the socket closed.
       A late callback cannot establish upload completion before that failure. */
    failureStage = ModelFailureStage.UPLOAD;
  } else {
    failureStage = ModelFailureStage.WAITING_FOR_HEADERS;
  }
  return { failureStage, connectionUse };
}
