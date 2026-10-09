import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { subscribe } from 'node:diagnostics_channel';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { z } from 'zod';
import {
  ModelTransportStage,
  ModelTransportSnapshotSchema,
  ModelTlsDetailsSchema,
  ModelTlsAlpnProtocol,
  type ModelTransportSnapshot,
} from '#contracts/ModelTransportDiagnostics.js';
import {
  describeSocketClose,
  SocketCloseDiagnosticsSchema,
  type SocketCloseDiagnostics,
} from './SocketCloseDiagnostics.js';

const activeAttempt = new AsyncLocalStorage<ModelTransportObserver>();
const requests = new WeakMap<object, ModelTransportObserver>();
const connections = new WeakMap<Socket, { id: string; observedAt: number; requests: number }>();
const RequestEventSchema = z.object({ request: z.unknown() });
const SocketEventSchema = z.object({ socket: z.instanceof(Socket) });
let subscribed = false;

function createMissingTransportSnapshot(): ModelTransportSnapshot {
  return {
    transportObserved: false,
    lastTransportStage: null,
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
  };
}

function subscribeToTransportChannel(name: string, callback: (message: unknown) => void): void {
  subscribe(name, (message) => {
    try {
      callback(message);
    } catch {
      // A subscriber exception must never terminate the process or interrupt fetch.
      readRequestOwner(message)?.recordDiagnosticsUnavailable();
    }
  });
}

function readRequestOwner(message: unknown): ModelTransportObserver | undefined {
  const parsed = RequestEventSchema.safeParse(message);
  const request = parsed.success ? parsed.data.request : undefined;
  return typeof request === 'object' && request !== null ? requests.get(request) : undefined;
}

/** Observe metadata only. Never read diagnostic headers, bodies, addresses or credentials. */
function subscribeToModelTransport(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  subscribeToTransportChannel('undici:request:create', (message) => {
    const owner = activeAttempt.getStore();
    const parsed = RequestEventSchema.safeParse(message);
    const request = parsed.success ? parsed.data.request : undefined;
    if (owner && typeof request === 'object' && request !== null) {
      requests.set(request, owner);
      owner.recordStage(ModelTransportStage.REQUEST_CREATED);
    }
  });
  subscribeToTransportChannel('undici:client:connected', (message) => {
    const parsed = SocketEventSchema.safeParse(message);
    if (parsed.success) {
      connections.set(parsed.data.socket, {
        id: randomUUID(),
        observedAt: performance.now(),
        requests: 0,
      });
    }
  });
  subscribeToTransportChannel('undici:client:sendHeaders', (message) => {
    const owner = readRequestOwner(message);
    const parsed = SocketEventSchema.safeParse(message);
    if (owner && parsed.success) {
      owner.recordSocket(parsed.data.socket);
    }
  });
  subscribeToTransportChannel('undici:request:bodySent', (message) => {
    readRequestOwner(message)?.recordBodySent();
  });
  subscribeToTransportChannel('undici:request:headers', (message) => {
    readRequestOwner(message)?.recordHeadersReceived();
  });
  subscribeToTransportChannel('undici:request:error', (message) => {
    readRequestOwner(message)?.recordStage(ModelTransportStage.REQUEST_FAILED);
  });
}

/** One fetch attempt. Socket counters measure local writes, not provider receipt.
 * Request identity, rather than ambient async context, owns events after dispatch.
 * Observation does not change fetch, pooling, retry, TLS or socket behavior. */
export class ModelTransportObserver {
  private observing = false;
  private finished = false;
  private diagnosticsUnavailable = false;
  private readonly startedAt = performance.now();
  private socket: Socket | null = null;
  private socketFailure: SocketCloseDiagnostics | undefined;
  private assignedAt: number | null = null;
  private writtenAtAssignment = 0;
  private readAtAssignment = 0;
  private connection: { id: string; observedAt: number; requests: number } | null = null;
  private snapshot: ModelTransportSnapshot = createMissingTransportSnapshot();

  async observe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      subscribeToModelTransport();
    } catch {
      this.recordDiagnosticsUnavailable();
    }
    this.observing = true;
    try {
      return await activeAttempt.run(this, operation);
    } finally {
      this.snapshot = this.readSnapshot();
      this.finished = true;
      this.observing = false;
      this.socket?.off('end', this.recordPeerEnd);
      this.socket?.off('error', this.recordSocketError);
      this.socket?.off('close', this.recordSocketClose);
    }
  }

  readSnapshot(): ModelTransportSnapshot {
    if (this.diagnosticsUnavailable) {
      return createMissingTransportSnapshot();
    }
    try {
      return this.captureSnapshot();
    } catch {
      this.recordDiagnosticsUnavailable();
      return createMissingTransportSnapshot();
    }
  }

  /** Retain the first native socket failure independently of fetch's eventual wrapper.
   * Return a validated copy so reporters cannot mutate the retained evidence. */
  readSocketFailure(): SocketCloseDiagnostics | undefined {
    return this.socketFailure === undefined
      ? undefined
      : SocketCloseDiagnosticsSchema.parse(this.socketFailure);
  }

  recordDiagnosticsUnavailable(): void {
    this.diagnosticsUnavailable = true;
  }

  private captureSnapshot(): ModelTransportSnapshot {
    if (this.finished) {
      return ModelTransportSnapshotSchema.parse(this.snapshot);
    }
    const socket = this.socket;
    const connection = this.connection;
    return ModelTransportSnapshotSchema.parse({
      ...this.snapshot,
      ...(socket
        ? {
            socketBytesWrittenSinceAssignment: Math.max(
              0,
              socket.bytesWritten - this.writtenAtAssignment,
            ),
            socketBytesReadSinceAssignment: Math.max(0, socket.bytesRead - this.readAtAssignment),
            socketDestroyed: socket.destroyed,
            socketPendingWriteBytes: socket.writableLength,
            socketWriteNeedsDrain: socket.writableNeedDrain,
            socketAssignedDurationMs:
              this.assignedAt === null ? null : Math.round(performance.now() - this.assignedAt),
          }
        : {}),
      ...(connection
        ? {
            connectionId: connection.id,
            connectionObservedDurationMs: Math.round(performance.now() - connection.observedAt),
            connectionObservedRequestCount: connection.requests,
            socketPeerEnded: this.snapshot.socketPeerEnded ?? false,
            socketErrorObserved: this.snapshot.socketErrorObserved ?? false,
            socketClosed: this.snapshot.socketClosed ?? false,
            socketCloseHadError: this.snapshot.socketCloseHadError ?? null,
          }
        : {}),
    });
  }

  recordStage(stage: ModelTransportSnapshot['lastTransportStage']): void {
    if (this.observing) {
      this.snapshot.transportObserved = true;
      this.snapshot.lastTransportStage = stage;
      if (stage !== null) {
        const events = this.snapshot.events ?? [];
        if (events.length < 16) {
          this.snapshot.events = [
            ...events,
            { stage, afterStartMs: Math.round(performance.now() - this.startedAt) },
          ];
        } else {
          this.snapshot.eventsTruncated = true;
        }
      }
    }
  }

  recordSocket(socket: Socket): void {
    if (!this.observing || this.socket) {
      return;
    }
    this.socket = socket;
    this.assignedAt = performance.now();
    this.writtenAtAssignment = socket.bytesWritten;
    this.readAtAssignment = socket.bytesRead;
    const existing = connections.get(socket);
    this.connection = existing ?? { id: randomUUID(), observedAt: this.assignedAt, requests: 0 };
    connections.set(socket, this.connection);
    this.connection.requests += 1;
    this.snapshot.connectionStarted =
      existing !== undefined && existing.observedAt >= this.startedAt;
    this.snapshot.connectionEstablished = !socket.destroyed;
    this.snapshot.socketAssigned = true;
    this.snapshot.socketHadPriorTraffic = socket.bytesWritten > 0 || socket.bytesRead > 0;
    this.snapshot.socketAddressFamily =
      socket.remoteFamily === 'IPv4' || socket.remoteFamily === 'IPv6' ? socket.remoteFamily : null;
    if (socket instanceof TLSSocket) {
      this.snapshot.tlsAuthorized = socket.authorized;
      const protocol = socket.getProtocol();
      this.snapshot.tlsProtocol =
        protocol === 'TLSv1.2' || protocol === 'TLSv1.3' ? protocol : null;
      const cipher = ModelTlsDetailsSchema.shape.tlsCipher.safeParse(socket.getCipher().name);
      this.snapshot.tlsCipher = cipher.success ? cipher.data : null;
      this.snapshot.tlsSessionReused = socket.isSessionReused();
      const alpn = socket.alpnProtocol;
      this.snapshot.tlsAlpnProtocol =
        alpn === ModelTlsAlpnProtocol.HTTP_1_1 || alpn === ModelTlsAlpnProtocol.HTTP_2
          ? alpn
          : ModelTlsAlpnProtocol.NONE;
    }
    socket.on('end', this.recordPeerEnd);
    socket.on('error', this.recordSocketError);
    socket.on('close', this.recordSocketClose);
    this.recordStage(ModelTransportStage.SOCKET_ASSIGNED);
  }

  recordBodySent(): void {
    if (this.observing) {
      this.snapshot.requestBodySent = true;
      this.snapshot.requestBodySentAfterSocketClosed = this.snapshot.socketClosed ?? false;
      this.recordStage(ModelTransportStage.BODY_SENT);
    }
  }

  recordHeadersReceived(): void {
    if (this.observing) {
      this.snapshot.providerHeadersReceived = true;
      this.recordStage(ModelTransportStage.RESPONSE_HEADERS);
    }
  }

  private readonly recordPeerEnd = (): void => {
    this.snapshot.socketPeerEnded = true;
    this.recordStage(ModelTransportStage.SOCKET_READ_ENDED);
  };

  private readonly recordSocketError = (error: unknown): void => {
    if (!this.observing) {
      return;
    }
    if (this.socketFailure === undefined) {
      try {
        this.socketFailure = describeSocketClose(error);
      } catch {
        this.recordDiagnosticsUnavailable();
      }
    }
    this.snapshot.socketErrorObserved = true;
    this.recordStage(ModelTransportStage.SOCKET_ERROR);
  };

  private readonly recordSocketClose = (hadError: boolean): void => {
    this.snapshot.socketClosed = true;
    this.snapshot.socketCloseHadError = hadError;
    this.recordStage(ModelTransportStage.SOCKET_CLOSED);
  };
}
