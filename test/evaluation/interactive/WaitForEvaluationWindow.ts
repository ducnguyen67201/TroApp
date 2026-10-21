import { MCPServerStdio } from '@openai/agents';
import { z } from 'zod';
import {
  DesktopDriverConnectionSchema,
  type DesktopDriverConnection,
} from '../../../src/contracts/DesktopDriver.js';

export const EvaluationWindowFailure = {
  CANCELLED: 'window_readiness_cancelled',
  TIMED_OUT: 'window_readiness_timed_out',
  PROBE_FAILED: 'window_probe_failed',
  CLEANUP_UNCONFIRMED: 'window_probe_cleanup_unconfirmed',
} as const;

export const EvaluationWindowLimits = {
  READY_MS: 15_000,
  REQUEST_MS: 3000,
  CLEANUP_MS: 5000,
  POLL_MS: 200,
  WINDOWS: 128,
} as const;

const EvaluationWindowTool = {
  LIST: 'list_windows',
  STATE: 'get_window_state',
} as const;

type EvaluationWindowTool = (typeof EvaluationWindowTool)[keyof typeof EvaluationWindowTool];

const TargetSchema = z.strictObject({
  processId: z.number().int().positive(),
  title: z.string().min(1).max(1000),
  documentName: z.string().min(1).max(256),
});

export type EvaluationWindowTarget = z.infer<typeof TargetSchema>;

/** Metadata-only proof of a ready owned window. It does not establish physical
 * display scan-out, visible teaching cues or correctness of the program. */
export interface EvaluationWindowReadiness {
  processId: number;
  windowId: number;
  windowObserved: true;
  documentObserved: true;
  contentObserved: true;
  elapsedMs: number;
}

export interface EvaluationWindowConnection {
  connect(): Promise<void>;
  callTool(
    name: EvaluationWindowTool,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface EvaluationWindowPorts {
  createConnection(connection: DesktopDriverConnection): EvaluationWindowConnection;
  now(): number;
}

const ResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().max(250_000).optional(),
        data: z
          .string()
          .max(8 * 1024 * 1024)
          .optional(),
      }),
    )
    .max(16),
});

const WindowSchema = z.object({
  pid: z.number().int().positive().nullable(),
  window_id: z.number().int().positive(),
  title: z.string().max(1000),
  is_on_screen: z.boolean(),
  on_current_space: z.boolean().nullable().optional(),
  minimized: z.boolean().optional(),
});

const WindowListSchema = z.object({
  windows: z.array(WindowSchema).max(EvaluationWindowLimits.WINDOWS),
});

const RefusedResultSchema = z.object({ status: z.literal('refused') });

const WindowStateSchema = z.object({
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
  window_title: z.string().max(1000),
  tree_markdown: z.string().max(250_000).optional(),
  elements: z
    .array(z.object({ role: z.string().min(1).max(128) }))
    .max(2000)
    .optional(),
  screenshot_frame_valid: z.boolean().optional(),
});

function createPorts(): EvaluationWindowPorts {
  return {
    now: () => performance.now(),
    createConnection: (connection) => {
      const server = new MCPServerStdio({
        name: 'Tro evaluation window readiness',
        ...connection,
        cacheToolsList: true,
        timeout: EvaluationWindowLimits.REQUEST_MS,
        clientSessionTimeoutSeconds: EvaluationWindowLimits.REQUEST_MS / 1000,
        logger: {
          namespace: 'tro-evaluation-window-readiness',
          debug: () => {},
          warn: () => {},
          error: () => {},
          dontLogModelData: true,
          dontLogToolData: true,
        },
      });
      return {
        connect: () => server.connect(),
        callTool: (name, arguments_, signal) =>
          server.callToolResult(name, arguments_, null, { signal }),
        close: () => server.close(),
      };
    },
  };
}

function readAbortFailure(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  const code =
    reason instanceof Error &&
    Object.values(EvaluationWindowFailure).some((value) => value === reason.message)
      ? reason.message
      : EvaluationWindowFailure.PROBE_FAILED;
  return new Error(code);
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  void operation.catch(() => undefined);
  if (signal.aborted) {
    return Promise.reject(readAbortFailure(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(readAbortFailure(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(readAbortFailure(signal));
    };
    const timer = setTimeout(finish, EvaluationWindowLimits.POLL_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}

function readCandidateWindow(input: unknown, target: EvaluationWindowTarget): number | null {
  const result = ResultSchema.safeParse(input);
  if (
    !result.success ||
    result.data.isError === true ||
    RefusedResultSchema.safeParse(result.data.structuredContent).success
  ) {
    return null;
  }
  const parsed = WindowListSchema.safeParse(result.data.structuredContent);
  if (!parsed.success) {
    return null;
  }
  const candidate = parsed.data.windows.find(
    (window) =>
      window.pid === target.processId &&
      window.title === target.title &&
      window.is_on_screen &&
      window.on_current_space !== false &&
      window.minimized !== true,
  );
  return candidate?.window_id ?? null;
}

function hasReadyWindowContent(
  input: unknown,
  target: EvaluationWindowTarget,
  windowId: number,
): boolean {
  const result = ResultSchema.safeParse(input);
  if (
    !result.success ||
    result.data.isError === true ||
    RefusedResultSchema.safeParse(result.data.structuredContent).success
  ) {
    return false;
  }
  const parsed = WindowStateSchema.safeParse(result.data.structuredContent);
  if (
    !parsed.success ||
    parsed.data.pid !== target.processId ||
    parsed.data.window_id !== windowId ||
    parsed.data.window_title !== target.title ||
    !parsed.data.window_title.includes(target.documentName)
  ) {
    return false;
  }
  const hasText =
    Boolean(parsed.data.tree_markdown?.trim()) || Boolean(parsed.data.elements?.length);
  const hasImage =
    parsed.data.screenshot_frame_valid === true &&
    result.data.content.some((part) => part.type === 'image' && Boolean(part.data?.length));
  return hasText || hasImage;
}

/** Probe only the host-owned connection and exact launched process. The pinned
 * Cua window contract provides title/visibility and scoped content; no focus,
 * input, launch or model call is performed here. Raw content is discarded. */
export async function waitForEvaluationWindow(
  connectionInput: DesktopDriverConnection,
  targetInput: EvaluationWindowTarget,
  signal?: AbortSignal,
  ports: EvaluationWindowPorts = createPorts(),
): Promise<EvaluationWindowReadiness> {
  const connection = DesktopDriverConnectionSchema.parse(connectionInput);
  const target = TargetSchema.parse(targetInput);
  if (signal?.aborted) {
    throw new Error(EvaluationWindowFailure.CANCELLED);
  }
  let server: EvaluationWindowConnection;
  try {
    server = ports.createConnection(connection);
  } catch {
    throw new Error(EvaluationWindowFailure.PROBE_FAILED);
  }
  const startedAt = ports.now();
  const cancellation = new AbortController();
  const cancel = (): void => {
    cancellation.abort(new Error(EvaluationWindowFailure.CANCELLED));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  const timeout = setTimeout(() => {
    cancellation.abort(new Error(EvaluationWindowFailure.TIMED_OUT));
  }, EvaluationWindowLimits.READY_MS);
  const operations: { pending: Promise<unknown> | null } = { pending: null };
  let readiness: EvaluationWindowReadiness | null = null;
  let failure: string | null = null;
  const runOperation = async <T>(operation: Promise<T>): Promise<T> => {
    operations.pending = operation;
    try {
      return await waitForOperation(operation, cancellation.signal);
    } finally {
      void operation.then(
        () => {
          if (operations.pending === operation) {
            operations.pending = null;
          }
        },
        () => {
          if (operations.pending === operation) {
            operations.pending = null;
          }
        },
      );
    }
  };
  try {
    await runOperation(server.connect());
    while (!cancellation.signal.aborted) {
      const windows = await runOperation(
        server.callTool(
          EvaluationWindowTool.LIST,
          { pid: target.processId, on_screen_only: false },
          cancellation.signal,
        ),
      );
      const windowId = readCandidateWindow(windows, target);
      if (windowId !== null) {
        const content = await runOperation(
          server.callTool(
            EvaluationWindowTool.STATE,
            {
              pid: target.processId,
              window_id: windowId,
              include_accessibility_tree: true,
              include_screenshot: true,
              max_elements: 256,
              max_depth: 16,
              max_dimension: 640,
              timeout_ms: 1000,
            },
            cancellation.signal,
          ),
        );
        if (hasReadyWindowContent(content, target, windowId)) {
          readiness = {
            processId: target.processId,
            windowId,
            windowObserved: true,
            documentObserved: true,
            contentObserved: true,
            elapsedMs: Math.max(0, ports.now() - startedAt),
          };
          break;
        }
      }
      await waitForPoll(cancellation.signal);
    }
    if (!readiness) {
      throw readAbortFailure(cancellation.signal);
    }
  } catch {
    if (cancellation.signal.aborted) {
      failure = signal?.aborted
        ? EvaluationWindowFailure.CANCELLED
        : EvaluationWindowFailure.TIMED_OUT;
    } else {
      failure = EvaluationWindowFailure.PROBE_FAILED;
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    cancellation.abort(new Error(EvaluationWindowFailure.CANCELLED));
  }
  const cleanup = new AbortController();
  const cleanupTimeout = setTimeout(() => {
    cleanup.abort(new Error(EvaluationWindowFailure.CLEANUP_UNCONFIRMED));
  }, EvaluationWindowLimits.CLEANUP_MS);
  try {
    await waitForOperation(
      (async () => {
        await operations.pending?.catch(() => undefined);
        await server.close();
      })(),
      cleanup.signal,
    );
  } catch {
    failure = EvaluationWindowFailure.CLEANUP_UNCONFIRMED;
  } finally {
    clearTimeout(cleanupTimeout);
  }
  if (signal?.aborted && failure !== EvaluationWindowFailure.CLEANUP_UNCONFIRMED) {
    failure = EvaluationWindowFailure.CANCELLED;
  }
  if (failure) {
    throw new Error(failure);
  }
  if (!readiness) {
    throw new Error(EvaluationWindowFailure.PROBE_FAILED);
  }
  return readiness;
}
