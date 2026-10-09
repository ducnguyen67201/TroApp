import {
  ModelRequestTraceHeader,
  ModelRequestTraceSchema,
  readModelGatewayDiagnostics,
} from '#contracts/ModelGatewayError.js';
import { randomUUID } from 'node:crypto';
import { enableAgentExchangeLog, logAgentExchange } from './AgentExchangeLog.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TaskContext } from '../execution/TaskContext.js';
import { TaskCompletionConfig, TaskTermination } from '../execution/TaskCompletionConfig.js';
import { TaskContextBudgetError } from '../execution/TaskContextBudget.js';
import pino, { type Logger } from 'pino';

export const AgentLogRole = { MAIN: 'main', VERIFIER: 'verifier' } as const;

export interface AgentLogContext {
  taskId: string;
  agentRole: (typeof AgentLogRole)[keyof typeof AgentLogRole];
  attemptNumber: number;
}

const agentLogContext = new AsyncLocalStorage<Readonly<AgentLogContext>>();

/** Bind metadata to the async SDK run, including nested verifier and fetch callbacks. */
export function withAgentLogContext<T>(
  context: AgentLogContext,
  execute: () => Promise<T>,
): Promise<T> {
  return agentLogContext.run(Object.freeze({ ...context }), execute);
}

export function readAgentLogContext(): Readonly<AgentLogContext> | undefined {
  return agentLogContext.getStore();
}

/** Worker-owned counters only; no instructions, criteria, evidence content or answer. */
export function describeTaskDiagnostics(task: TaskContext) {
  const snapshot = task.evidence.readSnapshot();
  const counts = task.readExecutionCounts();
  return {
    taskId: task.id,
    phase: task.phase,
    termination: task.termination,
    ...counts,
    ...task.readProgressDiagnostics(),
    remainingTimeMs: Math.round(task.readRemainingTimeMs()),
    remainingMainModelTurns: Math.max(
      0,
      task.config.initialModelTurns + task.config.recoveryModelTurns - counts.mainModelTurns,
    ),
    remainingVerificationAttempts: Math.max(
      0,
      task.config.maximumVerificationAttempts - counts.verificationAttempts,
    ),
    remainingToolCalls: Math.max(0, task.config.maximumToolCalls - counts.toolCalls),
    canContinue: task.canContinue(),
    canVerify: task.canVerify(),
    goalDefined: task.goal !== null,
    hasUsedDesktopTools: task.hasUsedDesktopTools,
    requiredCriteriaCount: task.goal?.criteria.length ?? 0,
    revision: snapshot.revision,
    evidenceVersion: snapshot.version,
    observationCount: snapshot.observations.length,
    admissibleObservationCount: snapshot.observations.filter((item) =>
      task.evidence.isAdmissible(item),
    ).length,
    pendingToolCalls: snapshot.inFlight,
    verificationId: task.latestVerification?.id ?? null,
  };
}

interface ModelRequestSummary {
  model: string | null;
  inputItems: number;
  textChars: number;
  imageParts: number;
  toolNames: string[];
  toolSchemaBytes: number;
}

interface ModelResponseSummary {
  outputTypes: string[];
  toolCalls: string[];
  inputTokens: number | null;
  outputTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/** Record only the shape of model traffic; text, images, and credentials stay out of logs. */
export function describeModelRequest(value: unknown): ModelRequestSummary {
  const request = isRecord(value) ? value : {};
  const input = request['input'];
  const inputItems: unknown[] = Array.isArray(input) ? input : [];
  const tools: unknown[] = Array.isArray(request['tools']) ? request['tools'] : [];
  let textChars = typeof input === 'string' ? input.length : 0;
  let imageParts = 0;

  const countContent = (content: unknown): void => {
    if (typeof content === 'string') {
      textChars += content.length;
    } else if (Array.isArray(content)) {
      const parts: unknown[] = content;
      for (const part of parts) {
        countContent(part);
      }
    } else if (isRecord(content)) {
      if (content['type'] === 'input_image' || content['type'] === 'image') {
        imageParts += 1;
      }
      if (typeof content['text'] === 'string') {
        textChars += content['text'].length;
      }
    }
  };
  for (const item of inputItems) {
    if (isRecord(item)) {
      countContent(item['content']);
      countContent(item['output']);
    }
  }

  return {
    model: readString(request['model']),
    inputItems: inputItems.length || (typeof input === 'string' ? 1 : 0),
    textChars,
    imageParts,
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(tools)),
    toolNames: tools.flatMap((tool) => {
      if (!isRecord(tool)) {
        return [];
      }
      const name = readString(tool['name']);
      return name ? [name] : [];
    }),
  };
}

/** Report model output kinds and usage without persisting its answer or tool arguments. */
export function describeModelResponse(value: unknown): ModelResponseSummary {
  const response = isRecord(value) ? value : {};
  const output: unknown[] = Array.isArray(response['output']) ? response['output'] : [];
  const usage = isRecord(response['usage']) ? response['usage'] : {};

  return {
    outputTypes: output.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const type = readString(item['type']);
      return type ? [type] : [];
    }),
    toolCalls: output.flatMap((item) => {
      if (!isRecord(item) || item['type'] !== 'function_call') {
        return [];
      }
      const name = readString(item['name']);
      return name ? [name] : [];
    }),
    inputTokens: readNumber(usage['input_tokens']),
    outputTokens: readNumber(usage['output_tokens']),
  };
}

export function createAgentDebugLogger(debugEnabled: boolean): Logger {
  const log = pino({ name: 'tro-desktop-agent', level: debugEnabled ? 'debug' : 'info' });
  if (debugEnabled) {
    enableAgentExchangeLog(log);
  }
  return log;
}

/** Observe the gateway exchange without logging HTTP headers, URLs, or bodies. */
export function createLoggedModelFetch(
  log: Logger,
  maximumBytes: number = TaskCompletionConfig.maximumModelRequestBytes,
): typeof fetch {
  let nextModelCall = 0;
  let previousToolCatalog = '';
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const modelRequestId = randomUUID();
    const metadata = {
      ...readAgentLogContext(),
      modelCallId: 'model-' + String(++nextModelCall),
      modelRequestId,
    };
    let requestBytes = 0;
    /* Always enforce the serialized request size, independent of debug logging.
       The SDK client has retries disabled so a rejected body never reaches a provider. */
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    if (request.body !== null) {
      const reader = request.body.getReader();

      try {
        let chunk = await reader.read();
        while (!chunk.done) {
          requestBytes += chunk.value.byteLength;
          if (requestBytes > maximumBytes) {
            await reader.cancel();
            log.debug(
              {
                ...metadata,
                requestBytes,
                maximumRequestBytes: maximumBytes,
                reason: TaskTermination.CONTEXT_LIMIT,
              },
              'openai.request.rejected',
            );
            throw new TaskContextBudgetError();
          }
          chunk = await reader.read();
        }
      } finally {
        reader.releaseLock();
      }
    }
    const startedAt = performance.now();
    const requestBody =
      typeof init?.body === 'string'
        ? readJson(init.body)
        : input instanceof Request && log.isLevelEnabled('debug')
          ? readJson(await input.clone().text())
          : null;
    const { toolNames, ...requestSummary } = describeModelRequest(requestBody);
    const toolCatalog = JSON.stringify(toolNames);
    log.debug(
      {
        ...metadata,
        ...requestSummary,
        requestBytes,
        toolCount: toolNames.length,
        ...(toolCatalog !== previousToolCatalog ? { toolNames } : {}),
      },
      'openai.request',
    );
    previousToolCatalog = toolCatalog;
    const exchangeInput = isRecord(requestBody)
      ? {
          model: requestBody['model'],
          input: requestBody['input'],
          instructionsChars:
            typeof requestBody['instructions'] === 'string'
              ? requestBody['instructions'].length
              : 0,
        }
      : null;

    try {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set(ModelRequestTraceHeader, modelRequestId);
      const response = await fetch(input, { ...init, headers });
      const returnedTrace = ModelRequestTraceSchema.safeParse(
        response.headers.get(ModelRequestTraceHeader),
      );
      const contentType = response.headers.get('content-type') ?? '';
      let responseBody: unknown = null;
      if (contentType.includes('application/json')) {
        try {
          responseBody = readJson(await response.clone().text());
        } catch {
          /* Diagnostics must never turn a successful model response into a failure. */
        }
      }
      const gatewayFailure = response.ok ? null : readModelGatewayDiagnostics(responseBody);
      log.debug(
        {
          ...metadata,
          ...(gatewayFailure ? { gatewayFailure } : {}),
          traceMatched: returnedTrace.success ? returnedTrace.data === modelRequestId : null,
          gatewayRequestId: /^req-[a-z0-9]+$/.test(response.headers.get('x-tro-request-id') ?? '')
            ? response.headers.get('x-tro-request-id')
            : null,
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
          ...describeModelResponse(responseBody),
        },
        'openai.response',
      );
      logAgentExchange(log, {
        operation: 'model.response',
        context: { ...metadata, status: response.status },
        input: exchangeInput,
        output: isRecord(responseBody)
          ? { output: responseBody['output'], error: responseBody['error'] }
          : null,
        ...(!response.ok ? { error: { httpStatus: response.status, gatewayFailure } } : {}),
      });
      return response;
    } catch (error) {
      logAgentExchange(log, {
        operation: 'model.response',
        context: metadata,
        input: exchangeInput,
        output: null,
        error,
      });
      log.debug(
        {
          ...metadata,
          errorType: error instanceof Error ? error.name : typeof error,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'openai.failed',
      );
      throw error;
    }
  };
}
