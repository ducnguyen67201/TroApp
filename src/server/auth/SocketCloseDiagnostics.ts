import { z } from 'zod';
import { NetworkErrorCodeSchema } from '#contracts/ModelGatewayError.js';
import { readTlsErrorNumbers, TlsErrorNumbersSchema } from './TlsErrorDiagnostics.js';

/* These additional codes describe the native socket error only. They must not change
 * the fetch failure classification used by the gateway's existing retry policy. */
const SocketErrorCode = {
  NETWORK_UNREACHABLE: 'ENETUNREACH',
  HOST_UNREACHABLE: 'EHOSTUNREACH',
  CLIENT_INFORMATION: 'UND_ERR_INFO',
  CLIENT_ABORTED: 'UND_ERR_ABORTED',
  CLIENT_DESTROYED: 'UND_ERR_DESTROYED',
  BODY_TIMEOUT: 'UND_ERR_BODY_TIMEOUT',
  REQUEST_LENGTH_MISMATCH: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  RESPONSE_LENGTH_MISMATCH: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  HEADERS_OVERFLOW: 'UND_ERR_HEADERS_OVERFLOW',
  TLS_INTERNAL_ALERT: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
  TLS_DECODE_ALERT: 'ERR_SSL_TLSV1_ALERT_DECODE_ERROR',
  TLS_BAD_RECORD_MAC: 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  /* OpenSSL 3.5 uses "ssl/tls alert" reason labels. Node uppercases them and
   * replaces spaces, retaining the slash in the actual native error code. */
  TLS_CURRENT_BAD_RECORD_MAC: 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
  TLS_CURRENT_BAD_CERTIFICATE: 'ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE',
  TLS_CURRENT_CERTIFICATE_EXPIRED: 'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_EXPIRED',
  TLS_CURRENT_CERTIFICATE_REVOKED: 'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_REVOKED',
  TLS_CURRENT_CERTIFICATE_UNKNOWN: 'ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN',
  TLS_CURRENT_DECOMPRESSION_FAILURE: 'ERR_SSL_SSL/TLS_ALERT_DECOMPRESSION_FAILURE',
  TLS_CURRENT_HANDSHAKE_FAILURE: 'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE',
  TLS_CURRENT_ILLEGAL_PARAMETER: 'ERR_SSL_SSL/TLS_ALERT_ILLEGAL_PARAMETER',
  TLS_CURRENT_NO_CERTIFICATE: 'ERR_SSL_SSL/TLS_ALERT_NO_CERTIFICATE',
  TLS_CURRENT_UNEXPECTED_MESSAGE: 'ERR_SSL_SSL/TLS_ALERT_UNEXPECTED_MESSAGE',
  TLS_CURRENT_UNSUPPORTED_CERTIFICATE: 'ERR_SSL_SSL/TLS_ALERT_UNSUPPORTED_CERTIFICATE',
  TLS_CERTIFICATE_REQUIRED: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
  TLS_MISSING_EXTENSION: 'ERR_SSL_TLSV13_ALERT_MISSING_EXTENSION',
  TLS_ACCESS_DENIED: 'ERR_SSL_TLSV1_ALERT_ACCESS_DENIED',
  TLS_DECRYPTION_FAILED: 'ERR_SSL_TLSV1_ALERT_DECRYPTION_FAILED',
  TLS_DECRYPT_ERROR: 'ERR_SSL_TLSV1_ALERT_DECRYPT_ERROR',
  TLS_EXPORT_RESTRICTION: 'ERR_SSL_TLSV1_ALERT_EXPORT_RESTRICTION',
  TLS_INAPPROPRIATE_FALLBACK: 'ERR_SSL_TLSV1_ALERT_INAPPROPRIATE_FALLBACK',
  TLS_INSUFFICIENT_SECURITY: 'ERR_SSL_TLSV1_ALERT_INSUFFICIENT_SECURITY',
  TLS_NO_APPLICATION_PROTOCOL: 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL',
  TLS_NO_RENEGOTIATION: 'ERR_SSL_TLSV1_ALERT_NO_RENEGOTIATION',
  TLS_RECORD_OVERFLOW: 'ERR_SSL_TLSV1_ALERT_RECORD_OVERFLOW',
  TLS_UNKNOWN_CA: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  TLS_UNKNOWN_PSK_IDENTITY: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_PSK_IDENTITY',
  TLS_USER_CANCELLED: 'ERR_SSL_TLSV1_ALERT_USER_CANCELLED',
  TLS_BAD_CERTIFICATE_HASH: 'ERR_SSL_TLSV1_BAD_CERTIFICATE_HASH_VALUE',
  TLS_BAD_CERTIFICATE_STATUS: 'ERR_SSL_TLSV1_BAD_CERTIFICATE_STATUS_RESPONSE',
  TLS_CERTIFICATE_UNOBTAINABLE: 'ERR_SSL_TLSV1_CERTIFICATE_UNOBTAINABLE',
  TLS_UNRECOGNIZED_NAME: 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME',
  TLS_UNSUPPORTED_EXTENSION: 'ERR_SSL_TLSV1_UNSUPPORTED_EXTENSION',
  TLS_BAD_RECORD: 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  TLS_BAD_RECORD_TYPE: 'ERR_SSL_BAD_RECORD_TYPE',
  TLS_DATA_AFTER_CLOSE: 'ERR_SSL_APPLICATION_DATA_AFTER_CLOSE_NOTIFY',
  TLS_BAD_WRITE_RETRY: 'ERR_SSL_BAD_WRITE_RETRY',
  TLS_RECORD_LAYER_FAILURE: 'ERR_SSL_RECORD_LAYER_FAILURE',
  TLS_PACKET_TOO_LONG: 'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  TLS_BAD_PACKET_LENGTH: 'ERR_SSL_BAD_PACKET_LENGTH',
  TLS_UNEXPECTED_MESSAGE: 'ERR_SSL_UNEXPECTED_MESSAGE',
  TLS_UNEXPECTED_RECORD: 'ERR_SSL_UNEXPECTED_RECORD',
  TLS_PROTOCOL_ALERT: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  TLS_HANDSHAKE_ALERT: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  TLS_UNEXPECTED_EOF: 'ERR_SSL_UNEXPECTED_EOF_WHILE_READING',
  TLS_WRONG_VERSION: 'ERR_SSL_WRONG_VERSION_NUMBER',
  TLS_HANDSHAKE_TIMEOUT: 'ERR_TLS_HANDSHAKE_TIMEOUT',
  TLS_CERTIFICATE_NAME: 'ERR_TLS_CERT_ALTNAME_INVALID',
  TLS_SELF_SIGNED: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  TLS_SELF_SIGNED_CHAIN: 'SELF_SIGNED_CERT_IN_CHAIN',
  SOCKET_CLOSED: 'ERR_SOCKET_CLOSED',
  SOCKET_SETUP_CLOSED: 'ERR_SOCKET_CLOSED_BEFORE_CONNECTION',
  STREAM_DESTROYED: 'ERR_STREAM_DESTROYED',
  STREAM_WRITE_AFTER_END: 'ERR_STREAM_WRITE_AFTER_END',
  STREAM_PREMATURE_CLOSE: 'ERR_STREAM_PREMATURE_CLOSE',
  HTTP_INVALID_HEADER: 'HPE_INVALID_HEADER_TOKEN',
  HTTP_INVALID_RESPONSE: 'HPE_INVALID_CONSTANT',
  HTTP_CLOSED_CONNECTION: 'HPE_CLOSED_CONNECTION',
} as const;

const SocketErrorFamily = {
  SYSTEM: 'system',
  TLS: 'tls',
  HTTP_CLIENT: 'http_client',
  HTTP_PARSER: 'http_parser',
  STREAM: 'stream',
  UNKNOWN: 'unknown',
} as const;

const SocketErrorCodeState = {
  RECOGNIZED: 'recognized',
  UNRECOGNIZED: 'unrecognized',
  MISSING: 'missing',
} as const;

const SocketErrorName = {
  ERROR: 'Error',
  TYPE_ERROR: 'TypeError',
  AGGREGATE_ERROR: 'AggregateError',
  INFORMATIONAL_ERROR: 'InformationalError',
  SOCKET_ERROR: 'SocketError',
  REQUEST_ABORTED: 'RequestAbortedError',
  HTTP_PARSER_ERROR: 'HTTPParserError',
  HEADERS_TIMEOUT: 'HeadersTimeoutError',
  BODY_TIMEOUT: 'BodyTimeoutError',
  CONNECT_TIMEOUT: 'ConnectTimeoutError',
} as const;

const SocketErrorReason = {
  CLIENT_RESET: 'client_reset',
  CLIENT_IDLE_TIMEOUT: 'client_idle_timeout',
  CLIENT_ABORTED: 'client_aborted',
  PROTOCOL_UPGRADE: 'protocol_upgrade',
  TLS_INTERNAL_ALERT: 'tls_internal_alert',
  TLS_DECODE_ALERT: 'tls_decode_alert',
  TLS_BAD_RECORD_MAC: 'tls_bad_record_mac',
  TLS_PROTOCOL_ALERT: 'tls_protocol_alert',
  TLS_UNEXPECTED_EOF: 'tls_unexpected_eof',
  UNCLASSIFIED: 'unclassified',
} as const;

const SocketErrorCodeSchema = z.enum([
  ...NetworkErrorCodeSchema.options,
  ...Object.values(SocketErrorCode),
]);
const SocketErrorNameSchema = z.enum(SocketErrorName);

const maximumSocketErrorDepth = 6;
const NativeSocketErrorSchema = z.object({
  code: z.unknown().optional(),
  name: z.unknown().optional(),
  message: z.unknown().optional(),
  library: z.unknown().optional(),
  cause: z.unknown().optional(),
});

const SocketErrorDetailsSchema = z.object({
  socketErrorCode: SocketErrorCodeSchema.nullable(),
  socketErrorCodeState: z.enum(SocketErrorCodeState),
  socketErrorFamily: z.enum(SocketErrorFamily),
  socketErrorName: SocketErrorNameSchema.nullable(),
  socketErrorReason: z.enum(SocketErrorReason),
  ...TlsErrorNumbersSchema.shape,
});

export const SocketCloseDiagnosticsSchema = SocketErrorDetailsSchema.extend({
  socketErrorCauses: z
    .array(
      SocketErrorDetailsSchema.extend({
        causeDepth: z
          .number()
          .int()
          .min(1)
          .max(maximumSocketErrorDepth - 1),
      }),
    )
    .max(maximumSocketErrorDepth - 1),
  socketErrorCausesTruncated: z.boolean(),
});

export type SocketCloseDiagnostics = z.infer<typeof SocketCloseDiagnosticsSchema>;

function readSocketErrorFamily(code: unknown): SocketCloseDiagnostics['socketErrorFamily'] {
  if (typeof code !== 'string') {
    return SocketErrorFamily.UNKNOWN;
  }
  if (
    code.startsWith('ERR_SSL_') ||
    code.startsWith('ERR_TLS_') ||
    [
      SocketErrorCode.TLS_SELF_SIGNED,
      SocketErrorCode.TLS_SELF_SIGNED_CHAIN,
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ].includes(code)
  ) {
    return SocketErrorFamily.TLS;
  }
  if (code.startsWith('UND_ERR_')) {
    return SocketErrorFamily.HTTP_CLIENT;
  }
  if (code.startsWith('HPE_')) {
    return SocketErrorFamily.HTTP_PARSER;
  }
  if (code.startsWith('ERR_STREAM_') || code.startsWith('ERR_SOCKET_')) {
    return SocketErrorFamily.STREAM;
  }
  return NetworkErrorCodeSchema.safeParse(code).success ||
    code === SocketErrorCode.NETWORK_UNREACHABLE ||
    code === SocketErrorCode.HOST_UNREACHABLE
    ? SocketErrorFamily.SYSTEM
    : SocketErrorFamily.UNKNOWN;
}

function readSocketErrorReason(
  code: unknown,
  message: unknown,
): SocketCloseDiagnostics['socketErrorReason'] {
  if (code === SocketErrorCode.CLIENT_INFORMATION) {
    switch (message) {
      case 'reset':
        return SocketErrorReason.CLIENT_RESET;
      case 'socket idle timeout':
        return SocketErrorReason.CLIENT_IDLE_TIMEOUT;
      case 'aborted':
        return SocketErrorReason.CLIENT_ABORTED;
      case 'upgrade':
        return SocketErrorReason.PROTOCOL_UPGRADE;
    }
  }
  switch (code) {
    case SocketErrorCode.TLS_INTERNAL_ALERT:
      return SocketErrorReason.TLS_INTERNAL_ALERT;
    case SocketErrorCode.TLS_DECODE_ALERT:
      return SocketErrorReason.TLS_DECODE_ALERT;
    case SocketErrorCode.TLS_BAD_RECORD_MAC:
    case SocketErrorCode.TLS_CURRENT_BAD_RECORD_MAC:
    case SocketErrorCode.TLS_BAD_RECORD:
      return SocketErrorReason.TLS_BAD_RECORD_MAC;
    case SocketErrorCode.TLS_PROTOCOL_ALERT:
      return SocketErrorReason.TLS_PROTOCOL_ALERT;
    case SocketErrorCode.TLS_UNEXPECTED_EOF:
      return SocketErrorReason.TLS_UNEXPECTED_EOF;
    default:
      return SocketErrorReason.UNCLASSIFIED;
  }
}

function readSocketErrorDetails(
  error: z.infer<typeof NativeSocketErrorSchema> | undefined,
): z.infer<typeof SocketErrorDetailsSchema> {
  const code = error?.code;
  const name = SocketErrorNameSchema.safeParse(error?.name);
  const recognizedCode = SocketErrorCodeSchema.safeParse(code);
  return SocketErrorDetailsSchema.parse({
    socketErrorCode: recognizedCode.success ? recognizedCode.data : null,
    socketErrorCodeState: recognizedCode.success
      ? SocketErrorCodeState.RECOGNIZED
      : code === undefined || code === null
        ? SocketErrorCodeState.MISSING
        : SocketErrorCodeState.UNRECOGNIZED,
    socketErrorFamily: readSocketErrorFamily(code),
    socketErrorName: name.success ? name.data : null,
    socketErrorReason: readSocketErrorReason(code, error?.message),
    ...readTlsErrorNumbers(error),
  });
}

/** Preserve the original error and at most five nested causes without raw error content.
 * Unknown codes are reduced to a family. Cycles/depth limits are marked explicitly;
 * nothing in this diagnostic selects a retry or retains the native error object. */
export function describeSocketClose(error: unknown): SocketCloseDiagnostics {
  const original = NativeSocketErrorSchema.safeParse(error);
  const socketErrorCauses: SocketCloseDiagnostics['socketErrorCauses'] = [];
  const visited = new Set<unknown>([error]);
  let current: unknown = original.success ? original.data.cause : undefined;
  let socketErrorCausesTruncated = false;
  for (let causeDepth = 1; current !== undefined && current !== null; causeDepth += 1) {
    if (causeDepth >= maximumSocketErrorDepth || visited.has(current)) {
      socketErrorCausesTruncated = true;
      break;
    }
    const parsed = NativeSocketErrorSchema.safeParse(current);
    if (!parsed.success) {
      break;
    }
    visited.add(current);
    socketErrorCauses.push({ causeDepth, ...readSocketErrorDetails(parsed.data) });
    current = parsed.data.cause;
  }
  return SocketCloseDiagnosticsSchema.parse({
    ...readSocketErrorDetails(original.success ? original.data : undefined),
    socketErrorCauses,
    socketErrorCausesTruncated,
  });
}
