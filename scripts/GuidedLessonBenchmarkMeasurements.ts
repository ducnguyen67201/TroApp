import { parseArgs } from 'node:util';
import { z } from 'zod';
import { LessonLanguage } from '../src/contracts/GuidedLessons.js';
import type { ModelTransportSnapshot } from '../src/contracts/ModelTransportDiagnostics.js';
import { ModelTransportObserver } from '../src/server/auth/ModelTransportObserver.js';
import type { SocketCloseDiagnostics } from '../src/server/auth/SocketCloseDiagnostics.js';

const TokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ProviderUsageSchema = z
  .object({
    input_tokens: TokenCountSchema,
    output_tokens: TokenCountSchema,
    total_tokens: TokenCountSchema,
    input_tokens_details: z
      .object({
        cached_tokens: TokenCountSchema.optional(),
        cache_write_tokens: TokenCountSchema.optional(),
      })
      .optional(),
    output_tokens_details: z.object({ reasoning_tokens: TokenCountSchema.optional() }).optional(),
  })
  .refine(
    (usage) =>
      usage.input_tokens + usage.output_tokens === usage.total_tokens &&
      (usage.input_tokens_details?.cached_tokens ?? 0) <= usage.input_tokens &&
      (usage.input_tokens_details?.cache_write_tokens ?? 0) <= usage.input_tokens &&
      (usage.output_tokens_details?.reasoning_tokens ?? 0) <= usage.output_tokens,
  );
const ProviderResponseSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(100).optional(),
  status: z
    .enum(['completed', 'incomplete', 'failed', 'cancelled', 'in_progress', 'queued'])
    .optional(),
  usage: ProviderUsageSchema.nullable().optional(),
  input_tokens: TokenCountSchema.optional(),
});

export const BenchmarkOptionsSchema = z.strictObject({
  language: z.enum(LessonLanguage).default(LessonLanguage.EN),
  seconds: z.coerce.number().int().min(30).max(300).default(30),
  runs: z.coerce.number().int().min(1).max(3).default(1),
  help: z.boolean().default(false),
});

export type BenchmarkOptions = z.infer<typeof BenchmarkOptionsSchema>;

export function readGuidedLessonBenchmarkOptions(arguments_: string[]): BenchmarkOptions {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      language: { type: 'string' },
      seconds: { type: 'string' },
      runs: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  return BenchmarkOptionsSchema.parse(values);
}

export interface BenchmarkModelMeasurement {
  stage: string;
  kind: 'generation' | 'inputCount';
  model: string | null;
  responseId: string | null;
  requestId: string | null;
  httpStatus: number | null;
  status:
    'completed' | 'incomplete' | 'failed' | 'cancelled' | 'in_progress' | 'queued' | 'unknown';
  wallTimeMs: number;
  countedInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningOutputTokens: number | null;
  aborted?: boolean;
  transport?: ModelTransportSnapshot;
  socketFailure?: SocketCloseDiagnostics;
}

/** Observe metadata only. Never persist provider payloads, prompts, authorization or reasoning text. */
export function createBenchmarkModelFetch(
  readStage: () => string,
  saveMeasurement: (measurement: BenchmarkModelMeasurement) => void,
  request: typeof fetch = fetch,
  observation?: { observeTransport?: boolean },
): typeof fetch {
  return async (input, options) => {
    const startedAt = performance.now();
    const stage = readStage();
    const requestUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const signal =
      options?.signal ?? (typeof input === 'string' || input instanceof URL ? null : input.signal);
    const transport = observation?.observeTransport ? new ModelTransportObserver() : undefined;
    const kind = new URL(requestUrl).pathname.endsWith('/input_tokens')
      ? 'inputCount'
      : 'generation';
    const measurement: BenchmarkModelMeasurement = {
      stage,
      kind,
      model: null,
      responseId: null,
      requestId: null,
      httpStatus: null,
      status: 'unknown',
      wallTimeMs: 0,
      countedInputTokens: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      reasoningOutputTokens: null,
    };
    try {
      const dispatch = (): Promise<Response> => request(input, options);
      const response = await (transport ? transport.observe(dispatch) : dispatch());
      measurement.httpStatus = response.status;
      const requestId = response.headers.get('x-request-id');
      measurement.requestId =
        requestId && /^[a-zA-Z0-9_-]{1,200}$/.test(requestId) ? requestId : null;
      if (response.headers.get('content-type')?.includes('application/json')) {
        let raw: unknown = null;
        try {
          raw = await response.clone().json();
        } catch {
          /* Usage stays unknown when a response body is incomplete. */
        }
        const parsed = ProviderResponseSchema.safeParse(raw);
        if (parsed.success) {
          const { usage } = parsed.data;
          measurement.model = parsed.data.model ?? null;
          measurement.responseId = parsed.data.id ?? null;
          measurement.status = parsed.data.status ?? (response.ok ? 'completed' : 'failed');
          measurement.countedInputTokens = parsed.data.input_tokens ?? null;
          measurement.inputTokens = usage?.input_tokens ?? null;
          measurement.outputTokens = usage?.output_tokens ?? null;
          measurement.totalTokens = usage?.total_tokens ?? null;
          measurement.cachedInputTokens = usage?.input_tokens_details?.cached_tokens ?? null;
          measurement.cacheWriteInputTokens =
            usage?.input_tokens_details?.cache_write_tokens ?? null;
          measurement.reasoningOutputTokens =
            usage?.output_tokens_details?.reasoning_tokens ?? null;
        }
      }
      return response;
    } finally {
      if (transport) {
        measurement.aborted = signal?.aborted ?? false;
        measurement.transport = transport.readSnapshot();
        const socketFailure = transport.readSocketFailure();
        if (socketFailure) {
          measurement.socketFailure = socketFailure;
        }
      }
      measurement.wallTimeMs = Math.round(performance.now() - startedAt);
      saveMeasurement(measurement);
    }
  };
}

/** Subset fields are reported separately; they never increase provider total token usage. */
export function sumBenchmarkModelUsage(measurements: readonly BenchmarkModelMeasurement[]): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
  unknownGenerationRequests: number;
  unknownCachedInputRequests: number;
  unknownCacheWriteRequests: number;
  unknownReasoningRequests: number;
} {
  return measurements
    .filter((measurement) => measurement.kind === 'generation')
    .reduce(
      (total, measurement) => ({
        inputTokens: total.inputTokens + (measurement.inputTokens ?? 0),
        outputTokens: total.outputTokens + (measurement.outputTokens ?? 0),
        totalTokens: total.totalTokens + (measurement.totalTokens ?? 0),
        cachedInputTokens: total.cachedInputTokens + (measurement.cachedInputTokens ?? 0),
        cacheWriteInputTokens:
          total.cacheWriteInputTokens + (measurement.cacheWriteInputTokens ?? 0),
        reasoningOutputTokens:
          total.reasoningOutputTokens + (measurement.reasoningOutputTokens ?? 0),
        unknownGenerationRequests:
          total.unknownGenerationRequests + (measurement.totalTokens === null ? 1 : 0),
        unknownCachedInputRequests:
          total.unknownCachedInputRequests + (measurement.cachedInputTokens === null ? 1 : 0),
        unknownCacheWriteRequests:
          total.unknownCacheWriteRequests + (measurement.cacheWriteInputTokens === null ? 1 : 0),
        unknownReasoningRequests:
          total.unknownReasoningRequests + (measurement.reasoningOutputTokens === null ? 1 : 0),
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
        unknownGenerationRequests: 0,
        unknownCachedInputRequests: 0,
        unknownCacheWriteRequests: 0,
        unknownReasoningRequests: 0,
      },
    );
}
