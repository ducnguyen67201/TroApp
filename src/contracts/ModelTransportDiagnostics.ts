import { z } from 'zod';

export const ModelTransportStage = {
  REQUEST_CREATED: 'request_created',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CONNECTION_FAILED: 'connection_failed',
  SOCKET_ASSIGNED: 'socket_assigned',
  BODY_WRITE_STARTED: 'body_write_started',
  BODY_SENT: 'body_sent',
  RESPONSE_HEADERS: 'response_headers',
  RESPONSE_COMPLETED: 'response_completed',
  REQUEST_FAILED: 'request_failed',
  SOCKET_READ_ENDED: 'socket_read_ended',
  SOCKET_ERROR: 'socket_error',
  SOCKET_CLOSED: 'socket_closed',
} as const;

export type ModelTransportStage = (typeof ModelTransportStage)[keyof typeof ModelTransportStage];

const socketByteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

export const ModelTlsCipher = {
  AES_128_GCM: 'TLS_AES_128_GCM_SHA256',
  AES_256_GCM: 'TLS_AES_256_GCM_SHA384',
  CHACHA20_POLY1305: 'TLS_CHACHA20_POLY1305_SHA256',
  ECDHE_RSA_AES_128_GCM: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  ECDHE_RSA_AES_256_GCM: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  ECDHE_RSA_CHACHA20: 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
  ECDHE_ECDSA_AES_128_GCM: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  ECDHE_ECDSA_AES_256_GCM: 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  ECDHE_ECDSA_CHACHA20: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
} as const;

export const ModelTlsAlpnProtocol = {
  HTTP_1_1: 'http/1.1',
  HTTP_2: 'h2',
  NONE: 'none',
} as const;

/** Negotiated public parameters only; session tickets and certificate identities stay local. */
export const ModelTlsDetailsSchema = z.object({
  tlsCipher: z.enum(ModelTlsCipher).nullable(),
  tlsSessionReused: z.boolean().nullable(),
  tlsAlpnProtocol: z.enum(ModelTlsAlpnProtocol).nullable(),
});

export type ModelTlsDetails = z.infer<typeof ModelTlsDetailsSchema>;

/** These are local writable-stream measurements, never proof of peer receipt. */
export const ModelSocketWriteSnapshotSchema = z.object({
  socketPendingWriteBytes: socketByteCount,
  socketWriteNeedsDrain: z.boolean(),
  socketDestroyed: z.boolean(),
});

export type ModelSocketWriteSnapshot = z.infer<typeof ModelSocketWriteSnapshotSchema>;

/** Connection IDs are random local identifiers, never addresses or provider identities. */
export const ModelConnectionSnapshotSchema = z
  .object({
    connectionId: z.uuid(),
    connectionObservedDurationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    socketPeerEnded: z.boolean(),
    socketErrorObserved: z.boolean(),
    socketClosed: z.boolean(),
    socketCloseHadError: z.boolean().nullable(),
    connectionObservedRequestCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    socketAssignedDurationMs: socketByteCount.optional(),
    socketDrainCountSinceAssignment: socketByteCount.optional(),
    socketLastDrainAfterAssignmentMs: socketByteCount.optional(),
    socketMaximumPendingWriteBytes: socketByteCount.optional(),
  })
  .extend(ModelTlsDetailsSchema.partial().shape)
  .extend(ModelSocketWriteSnapshotSchema.partial().shape);

export type ModelConnectionSnapshot = z.infer<typeof ModelConnectionSnapshotSchema>;

/** Safe transport evidence only; unknown fields are discarded before crossing processes. */
export const ModelTransportSnapshotSchema = z
  .object({
    transportObserved: z.boolean(),
    lastTransportStage: z.enum(ModelTransportStage).nullable(),
    connectionStarted: z.boolean(),
    connectionEstablished: z.boolean(),
    socketAssigned: z.boolean(),
    requestBodySent: z.boolean(),
    requestBodySentAfterSocketClosed: z.boolean().optional(),
    providerHeadersReceived: z.boolean(),
    providerResponseCompleted: z.boolean().optional(),
    socketHadPriorTraffic: z.boolean().nullable(),
    socketAddressFamily: z.enum(['IPv4', 'IPv6']).nullable().optional(),
    socketBytesWrittenSinceAssignment: socketByteCount,
    socketBytesReadSinceAssignment: socketByteCount,
    tlsAuthorized: z.boolean().nullable(),
    tlsProtocol: z.enum(['TLSv1.2', 'TLSv1.3']).nullable(),
    events: z
      .array(
        z.strictObject({
          stage: z.enum(ModelTransportStage),
          afterStartMs: z.number().int().nonnegative(),
        }),
      )
      .max(16)
      .optional(),
    eventsTruncated: z.boolean().optional(),
    connectionSetupDurationMs: socketByteCount.optional(),
    requestBodyBytesSubmitted: socketByteCount.optional(),
    requestBodyChunksSubmitted: socketByteCount.optional(),
    requestBodyLargestChunkBytes: socketByteCount.optional(),
    requestBodyFirstWriteAfterAssignmentMs: socketByteCount.optional(),
    requestBodyLastWriteAfterAssignmentMs: socketByteCount.optional(),
    requestBodySentAfterAssignmentMs: socketByteCount.optional(),
  })
  .extend(ModelConnectionSnapshotSchema.partial().shape);

export type ModelTransportSnapshot = z.infer<typeof ModelTransportSnapshotSchema>;
