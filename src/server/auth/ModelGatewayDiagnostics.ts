import { z } from 'zod';
import {
  ProviderErrorCodeSchema,
  ProviderErrorTypeSchema,
  NetworkErrorCodeSchema,
} from '#contracts/ModelGatewayError.js';

export const ModelGatewayFailure = {
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  CREDENTIAL_REQUIRED: 'credential_required',
  CREDENTIAL_INVALID: 'credential_invalid',
  REQUEST_INVALID: 'request_invalid',
  NETWORK_FAILED: 'provider_network_failed',
  PROVIDER_REJECTED: 'provider_rejected',
  BODY_MISSING: 'provider_body_missing',
  STREAM_FAILED: 'provider_stream_failed',
  CLIENT_DISCONNECTED: 'client_disconnected',
} as const;

export const ModelGatewayEvent = {
  REQUEST: 'model.gateway.request',
  REJECTED: 'model.gateway.rejected',
  RETRY: 'model.gateway.retry',
  FAILED: 'model.gateway.failed',
  COMPLETED: 'model.gateway.completed',
} as const;

/* Provider-owned vocabulary: unknown codes/messages must never become log content. */
const ProviderErrorCodes = new Set<string>(ProviderErrorCodeSchema.options);

const ProviderErrorTypes = new Set<string>(ProviderErrorTypeSchema.options);

const NetworkErrorCodes = new Set<string>(NetworkErrorCodeSchema.options);

const ProviderErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.unknown().optional(),
    type: z.unknown().optional(),
    param: z.unknown().optional(),
  }),
});

/** Accept only schema field paths; arbitrary provider params can contain user content. */
function readProviderParameter(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160) {
    return null;
  }
  return /^(?:model|input|tools|instructions|stream|max_output_tokens|previous_response_id|text|reasoning|temperature|top_p|parallel_tool_calls)(?:\[\d{1,5}\]|\.(?:content|type|text|image_url|image|detail|name|parameters|properties|required|additionalProperties|strict|format|schema|effort|arguments|output|call_id))*$/.test(
    value,
  )
    ? value
    : null;
}

export function readProviderRequestId(headers: Headers): string | null {
  const value = headers.get('x-request-id');
  return value !== null && /^req_[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

const SocketFailureReason = {
  PEER_CLOSED: 'peer_closed',
  CLOSED: 'closed',
  BAD_RESPONSE: 'bad_response',
  BAD_UPGRADE: 'bad_upgrade',
  UNCLASSIFIED: 'unclassified',
} as const;

type SocketFailureReason = (typeof SocketFailureReason)[keyof typeof SocketFailureReason];

interface SocketFailureDiagnostics {
  socketFailureReason: SocketFailureReason;
  socketBytesWritten: number | null;
  socketBytesRead: number | null;
}

/** Socket counters cover the connection lifetime, including any earlier pooled requests. */
function describeSocketFailure(message: unknown, socket: unknown): SocketFailureDiagnostics {
  const parsed = z
    .object({ bytesWritten: z.unknown().optional(), bytesRead: z.unknown().optional() })
    .safeParse(socket);
  let socketFailureReason: SocketFailureReason = SocketFailureReason.UNCLASSIFIED;
  switch (message) {
    case 'other side closed':
      socketFailureReason = SocketFailureReason.PEER_CLOSED;
      break;
    case 'closed':
      socketFailureReason = SocketFailureReason.CLOSED;
      break;
    case 'bad response':
      socketFailureReason = SocketFailureReason.BAD_RESPONSE;
      break;
    case 'bad upgrade':
      socketFailureReason = SocketFailureReason.BAD_UPGRADE;
      break;
  }
  return {
    socketFailureReason,
    socketBytesWritten: readSocketByteCount(parsed.success ? parsed.data.bytesWritten : undefined),
    socketBytesRead: readSocketByteCount(parsed.success ? parsed.data.bytesRead : undefined),
  };
}

function readSocketByteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function describeNetworkFailure(error: unknown): {
  errorType: string;
  networkCode: string | null;
  networkSyscall: string | null;
  networkErrno: number | null;
  causeDepth: number | null;
  socketFailureReason?: SocketFailureReason;
  socketBytesWritten?: number | null;
  socketBytesRead?: number | null;
} {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    const parsed = z
      .object({
        code: z.unknown().optional(),
        syscall: z.unknown().optional(),
        errno: z.unknown().optional(),
        cause: z.unknown().optional(),
        message: z.unknown().optional(),
        socket: z.unknown().optional(),
      })
      .safeParse(current);
    if (!parsed.success) {
      break;
    }
    const { code, syscall, errno } = parsed.data;
    if (typeof code === 'string' && NetworkErrorCodes.has(code)) {
      return {
        errorType: readNetworkErrorType(error),
        networkCode: code,
        networkSyscall:
          typeof syscall === 'string' &&
          ['write', 'read', 'connect', 'getaddrinfo'].includes(syscall)
            ? syscall
            : null,
        networkErrno:
          typeof errno === 'number' && Number.isSafeInteger(errno) && Math.abs(errno) <= 65535
            ? errno
            : null,
        causeDepth: depth,
        ...(code === 'UND_ERR_SOCKET'
          ? describeSocketFailure(parsed.data.message, parsed.data.socket)
          : {}),
      };
    }
    current = parsed.data.cause;
  }
  return {
    errorType: readNetworkErrorType(error),
    networkCode: null,
    networkSyscall: null,
    networkErrno: null,
    causeDepth: null,
  };
}

function readNetworkErrorType(error: unknown): string {
  return error instanceof Error &&
    ['AbortError', 'TimeoutError', 'TypeError', 'AggregateError'].includes(error.name)
    ? error.name
    : 'unknown';
}

interface ProviderFailureDiagnostics {
  providerErrorCode: string | null;
  providerErrorType: string | null;
  providerParameter: string | null;
  providerDiagnosticsAvailable: boolean;
}

/** Read bounded error JSON only. Never return raw messages, response text or headers. */
export async function readProviderFailure(response: Response): Promise<ProviderFailureDiagnostics> {
  const unavailable: ProviderFailureDiagnostics = {
    providerErrorCode: null,
    providerErrorType: null,
    providerParameter: null,
    providerDiagnosticsAvailable: false,
  };
  if (!response.body) {
    return unavailable;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > 16 * 1024) {
        await reader.cancel();
        return unavailable;
      }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const parsed = ProviderErrorSchema.safeParse(body);
    if (!parsed.success) {
      return unavailable;
    }
    const { code, type, param } = parsed.data.error;
    const providerErrorCode =
      typeof code === 'string' && ProviderErrorCodes.has(code) ? code : null;
    const providerErrorType =
      typeof type === 'string' && ProviderErrorTypes.has(type) ? type : null;
    const providerParameter = readProviderParameter(param);
    return {
      providerErrorCode,
      providerErrorType,
      providerParameter,
      providerDiagnosticsAvailable:
        providerErrorCode !== null || providerErrorType !== null || providerParameter !== null,
    };
  } catch {
    return unavailable;
  } finally {
    reader.releaseLock();
  }
}
